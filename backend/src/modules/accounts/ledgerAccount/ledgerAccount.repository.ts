import type { ClientSession } from 'mongoose';
import { ApiError } from '../../../lib/errors.js';
import { escapeRegex, pageOffset, type PageRequest } from '../../../lib/query.js';
import { changeRecord } from '../../../lib/records/recordWrites.js';
import { LedgerAccount, type LedgerAccountDoc, type LedgerAccountType } from '../models/ledgerAccount.js';

export type NewLedgerAccountRecord = Pick<LedgerAccountDoc, '_id' | 'code' | 'name' | 'type' | 'parentId' | 'description' | 'bankAccountNumber'>;
export type LedgerAccountChanges = Partial<Pick<LedgerAccountDoc, 'code' | 'name' | 'type' | 'description' | 'isActive'>> & {
  parentId?: string | null;
  /** null removes it. */
  bankAccountNumber?: string | null;
};
/** A starting account from the seed file, inserted only when its id isn't there yet. */
export type LedgerAccountSeedRow = NewLedgerAccountRecord;

export const ledgerAccountNotFound = () => new ApiError(404, 'unknown_ledger_account', 'No such account in the chart of accounts.');

interface WriteContext {
  actorId: string;
  expectedVersion?: number;
  session: ClientSession;
}

export interface LedgerAccountListFilter {
  type?: LedgerAccountType;
  isActive?: boolean;
  /** Matches the start of the code, or any part of the name. */
  search?: string;
}

export async function findLedgerAccountsPage({ type, isActive, search, ...page }: PageRequest & LedgerAccountListFilter) {
  const filter = {
    ...(type && { type }),
    ...(isActive !== undefined && { isActive }),
    ...(search && { $or: [{ code: { $regex: `^${escapeRegex(search)}` } }, { name: { $regex: escapeRegex(search), $options: 'i' } }] }),
  };
  const [accounts, total] = await Promise.all([
    LedgerAccount.find(filter).sort({ code: 1 }).skip(pageOffset(page)).limit(page.pageSize).lean(),
    LedgerAccount.countDocuments(filter),
  ]);
  return { accounts, total };
}

export const findLedgerAccountById = (accountId: string) => LedgerAccount.findById(accountId).lean();

export const findLedgerAccountsByIds = (accountIds: string[]) => LedgerAccount.find({ _id: { $in: accountIds } }).lean();

export const ledgerAccountCodeExists = async (code: string, exceptId?: string) =>
  Boolean(await LedgerAccount.exists({ code, ...(exceptId && { _id: { $ne: exceptId } }) }));

export const hasChildAccounts = async (accountId: string, onlyActive = false) =>
  Boolean(await LedgerAccount.exists({ parentId: accountId, ...(onlyActive && { isActive: true }) }));

/** Which of these accounts are the parent of at least one other account. */
export const findAccountsWithChildren = (accountIds: string[]): Promise<string[]> =>
  LedgerAccount.distinct('parentId', { parentId: { $in: accountIds } });

export async function insertLedgerAccount(record: NewLedgerAccountRecord, createdBy: string, session: ClientSession): Promise<LedgerAccountDoc> {
  const [created] = await LedgerAccount.create([{ ...record, isActive: true, createdBy, updatedBy: createdBy }], { session });
  if (!created) throw new Error('Creating the ledger account returned nothing.');
  return created.toObject();
}

export function updateLedgerAccount(accountId: string, { parentId, bankAccountNumber, ...changes }: LedgerAccountChanges, context: WriteContext) {
  // null removes the field (a parent: the account becomes top-level); undefined leaves it as it is.
  const $unset = { ...(parentId === null && { parentId: 1 }), ...(bankAccountNumber === null && { bankAccountNumber: 1 }) };
  const update = {
    $set: { ...changes, ...(parentId && { parentId }), ...(bankAccountNumber && { bankAccountNumber }) },
    ...(Object.keys($unset).length > 0 && { $unset }),
  };
  return changeRecord(LedgerAccount, accountId, update, context, ledgerAccountNotFound);
}

/** Adds the starting chart without touching accounts that already exist, so re-seeding never undoes edits made in the app. */
export async function insertMissingLedgerAccounts(rows: LedgerAccountSeedRow[], session: ClientSession): Promise<void> {
  if (rows.length === 0) return;
  await LedgerAccount.bulkWrite(
    rows.map(({ _id, ...row }) => ({ updateOne: { filter: { _id }, update: { $setOnInsert: { ...row, isActive: true, version: 0 } }, upsert: true } })),
    { session },
  );
}
