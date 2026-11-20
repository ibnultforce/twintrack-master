import { randomUUID } from 'node:crypto';
import type { ClientSession, UpdateQuery } from 'mongoose';
import { runInTransaction } from '../../../db.js';
import { ApiError } from '../../../lib/errors.js';
import type { PageRequest } from '../../../lib/query.js';
import { actorFields, type Actor } from '../../master/access/caller.js';
import { recordAudit } from '../../master/audit/audit.repository.js';
import { assertMayWriteFields, readFieldRules, redactHistory, redactRecord, type FieldRules } from '../../master/records/fieldSecurity.service.js';
import { listRecordHistory, writeRecordHistory } from '../../master/records/recordHistory.service.js';
import { findUsersByIds } from '../../master/users/users.repository.js';
import { ACCOUNTS_MODULE_KEY } from '../accountsModule.js';
import { assertMayDecide, mayDecide } from '../approvals/approvalRules.js';
import { checkBalancedLines, postEntry, reverseEntry, type NewLedgerLine } from '../ledger/ledger.service.js';
import type { JournalVoucherDoc, JournalVoucherStatus } from '../models/journalVoucher.js';
import {
  changeJournalVoucher,
  findJournalVoucherById,
  findJournalVouchersPage,
  insertJournalVoucher,
  journalVoucherNotFound,
  takeNextVoucherNumber,
  type JournalVoucherListFilter,
} from './journalVoucher.repository.js';

const JOURNAL_VOUCHER_RESOURCE = 'journalVoucher';
const APPROVE_PERMISSION = 'journalVoucher.approve';
const NUMBER_PREFIX = 'JV-';
const NUMBER_DIGITS = 4;

export interface JournalVoucherDetails {
  voucherDate: string;
  memo: string;
  lines: NewLedgerLine[];
}

const fieldRulesFor = (actor: Actor) => readFieldRules(actor, ACCOUNTS_MODULE_KEY, JOURNAL_VOUCHER_RESOURCE);

const historyRef = (voucherId: string) => ({ module: ACCOUNTS_MODULE_KEY, object: JOURNAL_VOUCHER_RESOURCE, recordId: voucherId });

const STATUS_LABELS: Record<JournalVoucherStatus, string> = { draft: 'a draft', submitted: 'waiting for approval', recorded: 'recorded', reversed: 'reversed' };

const wrongStatus = (voucher: JournalVoucherDoc, allowed: JournalVoucherStatus, action: string) =>
  new ApiError(409, `voucher_not_${allowed}`, `This voucher is ${STATUS_LABELS[voucher.status]}, so it can't be ${action}.`);

function assertStatus(voucher: JournalVoucherDoc, allowed: JournalVoucherStatus, action: string): void {
  if (voucher.status !== allowed) throw wrongStatus(voucher, allowed, action);
}

async function requireJournalVoucher(voucherId: string): Promise<JournalVoucherDoc> {
  const voucher = await findJournalVoucherById(voucherId);
  if (!voucher) throw journalVoucherNotFound();
  return voucher;
}

/** Names for the people a voucher mentions, so screens can show who made, submitted, approved and reversed it. */
async function peopleNamed(vouchers: JournalVoucherDoc[]): Promise<Map<string, string>> {
  const ids = new Set(vouchers.flatMap((voucher) => [voucher.createdBy, voucher.submittedBy, voucher.approvedBy, voucher.reversedBy]).filter((id): id is string => Boolean(id)));
  return new Map((await findUsersByIds([...ids])).map((person) => [person._id, person.name]));
}

const personRef = (id: string | undefined, names: Map<string, string>) => (id ? { id, name: names.get(id) } : undefined);

function toJournalVoucherView(voucher: JournalVoucherDoc, rules: FieldRules, names: Map<string, string>) {
  return redactRecord({
    id: voucher._id,
    number: voucher.number,
    voucherDate: voucher.voucherDate,
    memo: voucher.memo,
    lines: voucher.lines,
    total: voucher.total,
    status: voucher.status,
    returnNote: voucher.returnNote,
    createdBy: personRef(voucher.createdBy, names),
    createdAt: voucher.createdAt,
    submittedBy: personRef(voucher.submittedBy, names),
    submittedAt: voucher.submittedAt,
    approvedBy: personRef(voucher.approvedBy, names),
    approvedAt: voucher.approvedAt,
    ledgerEntryId: voucher.ledgerEntryId,
    reversedBy: personRef(voucher.reversedBy, names),
    reversedAt: voucher.reversedAt,
    reversalEntryId: voucher.reversalEntryId,
    version: voucher.version,
    updatedAt: voucher.updatedAt,
  }, rules);
}

const auditFields = (actor: Actor, voucher: JournalVoucherDoc) => ({
  ...actorFields(actor),
  targetType: JOURNAL_VOUCHER_RESOURCE,
  targetId: voucher._id,
  targetName: `${voucher.number} ${voucher.memo}`,
  module: ACCOUNTS_MODULE_KEY,
});

/** Saves one change with its history and activity log entry, in one transaction with any ledger work it does first. */
async function changeVoucher(
  actor: Actor,
  existing: JournalVoucherDoc,
  auditAction: string,
  buildUpdate: (session: ClientSession) => Promise<UpdateQuery<JournalVoucherDoc>>,
  expectedVersion = existing.version,
): Promise<JournalVoucherDoc> {
  return runInTransaction(async (session) => {
    const update = await buildUpdate(session);
    const saved = await changeJournalVoucher(existing._id, update, { actorId: actor.user._id, expectedVersion, session });
    await writeRecordHistory(historyRef(existing._id), { action: 'updated', actor, before: existing, after: saved }, session);
    await recordAudit({ action: auditAction, ...auditFields(actor, saved) }, session);
    return saved;
  });
}

async function toViewFor(actor: Actor, voucher: JournalVoucherDoc) {
  return toJournalVoucherView(voucher, await fieldRulesFor(actor), await peopleNamed([voucher]));
}

export async function listJournalVouchers(actor: Actor, query: PageRequest & JournalVoucherListFilter) {
  const [{ vouchers, total }, rules] = await Promise.all([findJournalVouchersPage(query), fieldRulesFor(actor)]);
  const names = await peopleNamed(vouchers);
  return { total, page: query.page, pageSize: query.pageSize, vouchers: vouchers.map((voucher) => toJournalVoucherView(voucher, rules, names)) };
}

/** One voucher, with what the caller may do to it next, so a screen shows only the buttons that will work. */
export async function getJournalVoucher(actor: Actor, voucherId: string) {
  const voucher = await requireJournalVoucher(voucherId);
  const canDecide = await mayDecide(actor, voucher, APPROVE_PERMISSION);
  const canUpdate = Boolean(actor.permissions['journalVoucher.update']);
  return {
    ...(await toViewFor(actor, voucher)),
    allowedActions: {
      edit: canUpdate && voucher.status === 'draft',
      submit: canUpdate && voucher.status === 'draft',
      approve: canDecide && voucher.status === 'submitted',
      return: canDecide && voucher.status === 'submitted',
      reverse: canDecide && voucher.status === 'recorded',
    },
  };
}

export async function createJournalVoucher(actor: Actor, details: JournalVoucherDetails) {
  assertMayWriteFields(await fieldRulesFor(actor), Object.keys(details), 'create');
  const { lines, total } = await checkBalancedLines(details.lines);
  const number = `${NUMBER_PREFIX}${String(await takeNextVoucherNumber()).padStart(NUMBER_DIGITS, '0')}`;

  const voucher = await runInTransaction(async (session) => {
    const created = await insertJournalVoucher({ _id: `jv_${randomUUID()}`, number, voucherDate: details.voucherDate, memo: details.memo, lines, total }, actor.user._id, session);
    await writeRecordHistory(historyRef(created._id), { action: 'created', actor, after: created }, session);
    await recordAudit({ action: 'journalVoucher.created', ...auditFields(actor, created) }, session);
    return created;
  });
  return toViewFor(actor, voucher);
}

/** Edits a draft. Once submitted, a voucher changes only by being returned to its maker, or reversed once recorded. */
export async function updateJournalVoucher(actor: Actor, voucherId: string, request: Partial<JournalVoucherDetails> & { version?: number }) {
  const { version, ...changes } = request;
  const existing = await requireJournalVoucher(voucherId);
  assertStatus(existing, 'draft', 'edited');
  assertMayWriteFields(await fieldRulesFor(actor), Object.keys(changes), 'update');
  const checked = changes.lines ? await checkBalancedLines(changes.lines) : undefined;

  const $set = { ...(changes.voucherDate && { voucherDate: changes.voucherDate }), ...(changes.memo && { memo: changes.memo }), ...checked };
  const saved = await changeVoucher(actor, existing, 'journalVoucher.updated', async () => ({ $set }), version);
  return toViewFor(actor, saved);
}

/** Sends a draft for approval. The lines are checked again, since an account may have been closed since it was saved. */
export async function submitJournalVoucher(actor: Actor, voucherId: string, version?: number) {
  const existing = await requireJournalVoucher(voucherId);
  assertStatus(existing, 'draft', 'submitted');
  await checkBalancedLines(existing.lines);

  const saved = await changeVoucher(actor, existing, 'journalVoucher.submitted', async () => ({
    $set: { status: 'submitted', submittedBy: actor.user._id, submittedAt: new Date() },
    $unset: { returnNote: 1 },
  }), version);
  return toViewFor(actor, saved);
}

/** Approves a submitted voucher and records it in the ledger, in one transaction: both happen, or neither does. */
export async function approveJournalVoucher(actor: Actor, voucherId: string, version?: number) {
  const existing = await requireJournalVoucher(voucherId);
  assertStatus(existing, 'submitted', 'approved');
  await assertMayDecide(actor, existing, APPROVE_PERMISSION);

  const saved = await changeVoucher(actor, existing, 'journalVoucher.approved', async (session) => {
    const entry = await postEntry(actor, {
      entryDate: existing.voucherDate,
      memo: `${existing.number} ${existing.memo}`,
      source: { type: JOURNAL_VOUCHER_RESOURCE, id: existing._id },
      lines: existing.lines,
    }, session);
    return { $set: { status: 'recorded', approvedBy: actor.user._id, approvedAt: new Date(), ledgerEntryId: entry._id } };
  }, version);
  return toViewFor(actor, saved);
}

/** Sends a submitted voucher back to its maker as a draft, with a note saying what to fix. */
export async function returnJournalVoucher(actor: Actor, voucherId: string, request: { note: string; version?: number }) {
  const existing = await requireJournalVoucher(voucherId);
  assertStatus(existing, 'submitted', 'returned');
  await assertMayDecide(actor, existing, APPROVE_PERMISSION);

  const saved = await changeVoucher(actor, existing, 'journalVoucher.returned', async () => ({
    $set: { status: 'draft', returnNote: request.note },
    $unset: { submittedBy: 1, submittedAt: 1 },
  }), request.version);
  return toViewFor(actor, saved);
}

/**
 * Cancels a recorded voucher with a reversal in the ledger, dated today. The voucher and its original entry stay as
 * they were. The maker can't reverse their own voucher, for the same reason they can't approve it.
 */
export async function reverseJournalVoucher(actor: Actor, voucherId: string, request: { memo?: string; version?: number }) {
  const existing = await requireJournalVoucher(voucherId);
  assertStatus(existing, 'recorded', 'reversed');
  await assertMayDecide(actor, existing, APPROVE_PERMISSION);
  const ledgerEntryId = existing.ledgerEntryId;
  if (!ledgerEntryId) throw new Error(`Recorded voucher ${existing._id} has no ledger entry.`);

  const saved = await changeVoucher(actor, existing, 'journalVoucher.reversed', async (session) => {
    const reversal = await reverseEntry(actor, ledgerEntryId, session, { memo: request.memo?.trim() || `Reversal of ${existing.number} ${existing.memo}` });
    return { $set: { status: 'reversed', reversedBy: actor.user._id, reversedAt: new Date(), reversalEntryId: reversal._id } };
  }, request.version);
  return toViewFor(actor, saved);
}

export async function getJournalVoucherHistory(actor: Actor, voucherId: string, page: PageRequest) {
  await requireJournalVoucher(voucherId);
  const history = await listRecordHistory(historyRef(voucherId), page);
  return { ...history, entries: redactHistory(history.entries, await fieldRulesFor(actor)) };
}
