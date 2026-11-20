import { randomUUID } from 'node:crypto';
import { isDuplicateKeyError, runInTransaction } from '../../../db.js';
import { ApiError } from '../../../lib/errors.js';
import type { PageRequest } from '../../../lib/query.js';
import { actorFields, type Actor } from '../../master/access/caller.js';
import { recordAudit } from '../../master/audit/audit.repository.js';
import { assertMayWriteFields, readFieldRules, redactHistory, redactRecord, type FieldRules } from '../../master/records/fieldSecurity.service.js';
import { listRecordHistory, writeRecordHistory } from '../../master/records/recordHistory.service.js';
import { ACCOUNTS_MODULE_KEY } from '../accountsModule.js';
import { accountHasLedgerLines, findAccountBalance } from '../ledger/ledger.repository.js';
import { NORMAL_BALANCE, type LedgerAccountDoc, type LedgerAccountType } from '../models/ledgerAccount.js';
import {
  findLedgerAccountById,
  findLedgerAccountsPage,
  hasChildAccounts,
  insertLedgerAccount,
  ledgerAccountCodeExists,
  ledgerAccountNotFound,
  updateLedgerAccount as saveLedgerAccountChanges,
  type LedgerAccountChanges,
  type LedgerAccountListFilter,
  type NewLedgerAccountRecord,
} from './ledgerAccount.repository.js';

const LEDGER_ACCOUNT_RESOURCE = 'ledgerAccount';

/** Deep enough for any real chart, and a guard against walking a broken parent chain forever. */
const MAX_ACCOUNT_DEPTH = 10;

export type NewLedgerAccountDetails = Omit<NewLedgerAccountRecord, '_id'>;

const fieldRulesFor = (actor: Actor) => readFieldRules(actor, ACCOUNTS_MODULE_KEY, LEDGER_ACCOUNT_RESOURCE);

const historyRef = (accountId: string) => ({ module: ACCOUNTS_MODULE_KEY, object: LEDGER_ACCOUNT_RESOURCE, recordId: accountId });

const invalidField = (path: string, message: string) => new ApiError(422, 'validation_failed', 'Some fields are invalid.', [{ path, message }]);

const duplicateCode = (code: string) => new ApiError(409, 'duplicate_account_code', `Another account already uses the code ${code}.`);

function toLedgerAccountView(account: LedgerAccountDoc, rules: FieldRules) {
  return redactRecord({
    id: account._id,
    code: account.code,
    name: account.name,
    type: account.type,
    normalBalance: NORMAL_BALANCE[account.type],
    parentId: account.parentId,
    description: account.description,
    bankAccountNumber: account.bankAccountNumber,
    isActive: account.isActive,
    version: account.version,
    createdBy: account.createdBy,
    createdAt: account.createdAt,
    updatedBy: account.updatedBy,
    updatedAt: account.updatedAt,
  }, rules);
}

const auditFields = (actor: Actor, account: LedgerAccountDoc) => ({
  ...actorFields(actor),
  targetType: LEDGER_ACCOUNT_RESOURCE,
  targetId: account._id,
  targetName: `${account.code} ${account.name}`,
  module: ACCOUNTS_MODULE_KEY,
});

async function requireLedgerAccount(accountId: string): Promise<LedgerAccountDoc> {
  const account = await findLedgerAccountById(accountId);
  if (!account) throw ledgerAccountNotFound();
  return account;
}

async function assertCodeIsFree(code: string, exceptId?: string): Promise<void> {
  if (await ledgerAccountCodeExists(code, exceptId)) throw duplicateCode(code);
}

/**
 * A parent must exist, be active and have the same type, and must not be the account itself or one of its own
 * sub-accounts, which would make a loop. `accountId` is missing for a new account, which can't be in a loop yet.
 */
async function assertValidParent(parentId: string, type: LedgerAccountType, accountId?: string): Promise<void> {
  const parent = await findLedgerAccountById(parentId);
  if (!parent) throw invalidField('parentId', 'no such account');
  if (!parent.isActive) throw invalidField('parentId', 'is inactive');
  if (parent.type !== type) throw invalidField('parentId', `has the type ${parent.type}, and a parent must have the same type`);
  // A group holds no money itself, so an account that already has ledger lines can't become one.
  if (await accountHasLedgerLines(parent._id)) throw invalidField('parentId', "has ledger lines, so it can't group other accounts");

  let ancestor: LedgerAccountDoc | null = parent;
  for (let depth = 1; ancestor; depth += 1) {
    if (ancestor._id === accountId) throw invalidField('parentId', 'is this account or one of its own sub-accounts');
    if (depth >= MAX_ACCOUNT_DEPTH) throw invalidField('parentId', `would make the chart deeper than ${MAX_ACCOUNT_DEPTH} levels`);
    ancestor = ancestor.parentId ? await findLedgerAccountById(ancestor.parentId) : null;
  }
}

/** Two people saving the same code at once both pass the check above; the unique index refuses the second. */
async function saveWithUniqueCode<Result>(code: string | undefined, save: () => Promise<Result>): Promise<Result> {
  try {
    return await save();
  } catch (error) {
    if (code && isDuplicateKeyError(error)) throw duplicateCode(code);
    throw error;
  }
}

export async function listLedgerAccounts(actor: Actor, query: PageRequest & LedgerAccountListFilter) {
  const [{ accounts, total }, rules] = await Promise.all([findLedgerAccountsPage(query), fieldRulesFor(actor)]);
  return { total, page: query.page, pageSize: query.pageSize, accounts: accounts.map((account) => toLedgerAccountView(account, rules)) };
}

export async function getLedgerAccount(actor: Actor, accountId: string) {
  return toLedgerAccountView(await requireLedgerAccount(accountId), await fieldRulesFor(actor));
}

export async function createLedgerAccount(actor: Actor, details: NewLedgerAccountDetails) {
  const rules = await fieldRulesFor(actor);
  assertMayWriteFields(rules, Object.keys(details), 'create');
  await assertCodeIsFree(details.code);
  if (details.parentId) await assertValidParent(details.parentId, details.type);

  const record: NewLedgerAccountRecord = { ...details, _id: `la_${randomUUID()}` };
  const account = await saveWithUniqueCode(details.code, () => runInTransaction(async (session) => {
    const created = await insertLedgerAccount(record, actor.user._id, session);
    await writeRecordHistory(historyRef(created._id), { action: 'created', actor, after: created }, session);
    await recordAudit({ action: 'ledgerAccount.created', ...auditFields(actor, created) }, session);
    return created;
  }));
  return toLedgerAccountView(account, rules);
}

/** Checks a change against the rest of the chart: the code stays unique, and the tree stays one type with no loops. */
async function assertChangeKeepsChartValid(existing: LedgerAccountDoc, changes: LedgerAccountChanges): Promise<void> {
  if (changes.code !== undefined && changes.code !== existing.code) await assertCodeIsFree(changes.code, existing._id);

  const type = changes.type ?? existing.type;
  const typeChanged = type !== existing.type;
  if (typeChanged && (await hasChildAccounts(existing._id))) {
    throw new ApiError(409, 'account_has_sub_accounts', 'This account has sub-accounts, so its type can only change after they are moved.');
  }
  // Its lines would silently move to another part of the reports, such as from expenses to income.
  if (typeChanged && (await accountHasLedgerLines(existing._id))) {
    throw new ApiError(409, 'account_has_ledger_lines', "This account has ledger lines, so its type can't change. Open a new account instead.");
  }

  const parentId = changes.parentId === undefined ? existing.parentId : (changes.parentId ?? undefined);
  const parentChanged = changes.parentId !== undefined && changes.parentId !== (existing.parentId ?? null);
  if (parentId && (parentChanged || typeChanged)) await assertValidParent(parentId, type, existing._id);

  if (changes.isActive === false && existing.isActive) {
    if (await hasChildAccounts(existing._id, true)) {
      throw new ApiError(409, 'account_has_active_sub_accounts', "Deactivate or move this account's active sub-accounts first.");
    }
    // Nothing can post to an inactive account, so money left in it could never be moved out.
    if ((await findAccountBalance(existing._id)) !== 0) {
      throw new ApiError(409, 'account_has_balance', 'This account still has a balance. Move it to another account before deactivating.');
    }
  }
}

function auditActionFor(existing: LedgerAccountDoc, changes: LedgerAccountChanges): string {
  if (changes.isActive === undefined || changes.isActive === existing.isActive) return 'ledgerAccount.updated';
  return changes.isActive ? 'ledgerAccount.activated' : 'ledgerAccount.deactivated';
}

export async function updateLedgerAccount(actor: Actor, accountId: string, request: LedgerAccountChanges & { version?: number }) {
  const { version, ...changes } = request;
  const existing = await requireLedgerAccount(accountId);
  const rules = await fieldRulesFor(actor);
  assertMayWriteFields(rules, Object.keys(changes), 'update');
  await assertChangeKeepsChartValid(existing, changes);

  const saved = await saveWithUniqueCode(changes.code, () => runInTransaction(async (session) => {
    const result = await saveLedgerAccountChanges(accountId, changes, { actorId: actor.user._id, expectedVersion: version, session });
    await writeRecordHistory(historyRef(accountId), { action: 'updated', actor, before: existing, after: result }, session);
    await recordAudit({ action: auditActionFor(existing, changes), ...auditFields(actor, result) }, session);
    return result;
  }));
  return toLedgerAccountView(saved, rules);
}

/** An account's change history. A bank number is hidden in it exactly as it is on the account. */
export async function getLedgerAccountHistory(actor: Actor, accountId: string, page: PageRequest) {
  await requireLedgerAccount(accountId);
  const history = await listRecordHistory(historyRef(accountId), page);
  return { ...history, entries: redactHistory(history.entries, await fieldRulesFor(actor)) };
}
