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
import type { JournalVoucherDoc, JournalVoucherStatus, VoucherType } from '../models/journalVoucher.js';
import type { LedgerLine } from '../models/ledgerEntry.js';
import { findWaitingRequestFor } from '../updateRequest/updateRequest.repository.js';
import {
  changeJournalVoucher,
  findJournalVoucherById,
  findJournalVouchersPage,
  insertJournalVoucher,
  journalVoucherNotFound,
  takeNextVoucherNumber,
  type JournalVoucherListFilter,
} from './journalVoucher.repository.js';
import { assertIsMoneyAccount, buildMoneyVoucherLines, itemsOf, type MoneyVoucherItem, type MoneyVoucherType } from './moneyVoucher.js';

const JOURNAL_VOUCHER_RESOURCE = 'journalVoucher';
const APPROVE_PERMISSION = 'journalVoucher.approve';
const NUMBER_PREFIXES: Record<VoucherType, string> = { journal: 'JV-', payment: 'PV-', receipt: 'RV-' };
const NUMBER_DIGITS = 4;

/** What a person writes on any voucher. */
interface VoucherHeader {
  voucherDate: string;
  memo: string;
  party?: string;
  reference?: string;
}

export interface JournalVoucherDetails extends VoucherHeader {
  lines: NewLedgerLine[];
}

/** A payment or receipt: one cash or bank account, and what the money was for. */
export interface MoneyVoucherDetails extends VoucherHeader {
  party: string;
  moneyAccountId: string;
  lines: MoneyVoucherItem[];
}

/** Every edit to a draft says why, and the reason is kept in the voucher's history. */
interface DraftEdit {
  reason: string;
  version?: number;
}

const fieldRulesFor = (actor: Actor) => readFieldRules(actor, ACCOUNTS_MODULE_KEY, JOURNAL_VOUCHER_RESOURCE);

const historyRef = (voucherId: string) => ({ module: ACCOUNTS_MODULE_KEY, object: JOURNAL_VOUCHER_RESOURCE, recordId: voucherId });

const STATUS_LABELS: Record<JournalVoucherStatus, string> = { draft: 'a draft', submitted: 'waiting for approval', recorded: 'recorded', reversed: 'reversed' };

const wrongStatus = (voucher: JournalVoucherDoc, allowed: JournalVoucherStatus, action: string) =>
  new ApiError(409, `voucher_not_${allowed}`, `This voucher is ${STATUS_LABELS[voucher.status]}, so it can't be ${action}.`);

const TYPE_LABELS: Record<VoucherType, string> = { journal: 'journal', payment: 'payment', receipt: 'receipt' };

/** Vouchers saved before payment and receipt vouchers existed have no type, and are journal vouchers. */
const typeOf = (voucher: Pick<JournalVoucherDoc, 'voucherType'>): VoucherType => voucher.voucherType ?? 'journal';

function assertType(voucher: JournalVoucherDoc, expected: VoucherType): void {
  const actual = typeOf(voucher);
  if (actual !== expected) {
    throw new ApiError(409, 'wrong_voucher_type', `${voucher.number} is a ${TYPE_LABELS[actual]} voucher. Edit it as one.`);
  }
}

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
    voucherType: typeOf(voucher),
    number: voucher.number,
    voucherDate: voucher.voucherDate,
    memo: voucher.memo,
    party: voucher.party,
    reference: voucher.reference,
    moneyAccountId: voucher.moneyAccountId,
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
  reason?: string,
): Promise<JournalVoucherDoc> {
  return runInTransaction(async (session) => {
    const update = await buildUpdate(session);
    const saved = await changeJournalVoucher(existing._id, update, { actorId: actor.user._id, expectedVersion, session });
    await writeRecordHistory(historyRef(existing._id), { action: 'updated', actor, before: existing, after: saved, reason }, session);
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
  // Only one correction may wait per voucher, so the screen links to it instead of offering a second.
  const waitingRequest = voucher.status === 'recorded' ? await findWaitingRequestFor(voucher._id) : null;
  return {
    ...(await toViewFor(actor, voucher)),
    waitingUpdateRequest: waitingRequest ? { id: waitingRequest._id, number: waitingRequest.number } : undefined,
    allowedActions: {
      edit: canUpdate && voucher.status === 'draft',
      submit: canUpdate && voucher.status === 'draft',
      approve: canDecide && voucher.status === 'submitted',
      return: canDecide && voucher.status === 'submitted',
      reverse: canDecide && voucher.status === 'recorded',
      // A recorded voucher is never edited; it is corrected through an update request someone else approves.
      requestCorrection: Boolean(actor.permissions['updateRequest.create']) && voucher.status === 'recorded' && !waitingRequest,
    },
  };
}

/** The header fields to save: a blank party or reference is left out on create and removed on edit. */
function headerChanges(changes: Partial<VoucherHeader>): { $set: Partial<VoucherHeader>; $unset: Record<string, 1> } {
  const $set: Partial<VoucherHeader> = { ...(changes.voucherDate && { voucherDate: changes.voucherDate }), ...(changes.memo && { memo: changes.memo }) };
  const $unset: Record<string, 1> = {};
  for (const field of ['party', 'reference'] as const) {
    const value = changes[field];
    if (value === undefined) continue;
    if (value) $set[field] = value;
    else $unset[field] = 1;
  }
  return { $set, $unset };
}

async function insertVoucher(actor: Actor, voucherType: VoucherType, header: VoucherHeader, lines: NewLedgerLine[], moneyAccountId?: string) {
  const checked = await checkBalancedLines(lines);
  const number = `${NUMBER_PREFIXES[voucherType]}${String(await takeNextVoucherNumber(voucherType)).padStart(NUMBER_DIGITS, '0')}`;
  const { $set: headerFields } = headerChanges(header);

  const voucher = await runInTransaction(async (session) => {
    const created = await insertJournalVoucher(
      { _id: `jv_${randomUUID()}`, voucherType, number, voucherDate: header.voucherDate, memo: header.memo, ...headerFields, ...(moneyAccountId && { moneyAccountId }), ...checked },
      actor.user._id,
      session,
    );
    await writeRecordHistory(historyRef(created._id), { action: 'created', actor, after: created }, session);
    await recordAudit({ action: 'journalVoucher.created', ...auditFields(actor, created) }, session);
    return created;
  });
  return toViewFor(actor, voucher);
}

export async function createJournalVoucher(actor: Actor, details: JournalVoucherDetails) {
  assertMayWriteFields(await fieldRulesFor(actor), Object.keys(details), 'create');
  const { lines, ...header } = details;
  return insertVoucher(actor, 'journal', header, lines);
}

/** Makes a draft payment or receipt voucher, building its cash or bank line from the items. */
export async function createMoneyVoucher(actor: Actor, voucherType: MoneyVoucherType, details: MoneyVoucherDetails) {
  assertMayWriteFields(await fieldRulesFor(actor), Object.keys(details), 'create');
  const { lines: items, moneyAccountId, ...header } = details;
  await assertIsMoneyAccount(moneyAccountId);
  return insertVoucher(actor, voucherType, header, buildMoneyVoucherLines(voucherType, moneyAccountId, items), moneyAccountId);
}

/** The draft to edit, checked for type, status and field access before anything is worked out. */
async function requireEditableDraft(actor: Actor, voucherId: string, voucherType: VoucherType, changedFields: string[]): Promise<JournalVoucherDoc> {
  const existing = await requireJournalVoucher(voucherId);
  assertType(existing, voucherType);
  assertStatus(existing, 'draft', 'edited');
  assertMayWriteFields(await fieldRulesFor(actor), changedFields, 'update');
  return existing;
}

/** Saves an edit to a draft, with its reason in the history. */
async function saveDraftEdit(actor: Actor, existing: JournalVoucherDoc, update: UpdateQuery<JournalVoucherDoc>, edit: DraftEdit) {
  const saved = await changeVoucher(actor, existing, 'journalVoucher.updated', async () => update, edit.version, edit.reason);
  return toViewFor(actor, saved);
}

/**
 * Edits a draft journal voucher. Once submitted, a voucher changes only by being returned to its maker, or, once
 * recorded, through an update request or a reversal.
 */
export async function updateJournalVoucher(actor: Actor, voucherId: string, request: Partial<JournalVoucherDetails> & DraftEdit) {
  const { version, reason, lines, ...header } = request;
  const existing = await requireEditableDraft(actor, voucherId, 'journal', Object.keys({ ...header, ...(lines && { lines }) }));
  const checked = lines ? await checkBalancedLines(lines) : undefined;
  const { $set, $unset } = headerChanges(header);
  return saveDraftEdit(actor, existing, { $set: { ...$set, ...checked }, $unset }, { reason, version });
}

/** Edits a draft payment or receipt. A new money account or new items rebuild its lines; the part not sent is kept. */
export async function updateMoneyVoucher(actor: Actor, voucherType: MoneyVoucherType, voucherId: string, request: Partial<MoneyVoucherDetails> & DraftEdit) {
  const { version, reason, lines: newItems, moneyAccountId: newMoneyAccountId, ...header } = request;
  const changedFields = Object.keys({ ...header, ...(newItems && { lines: newItems }), ...(newMoneyAccountId && { moneyAccountId: newMoneyAccountId }) });
  const existing = await requireEditableDraft(actor, voucherId, voucherType, changedFields);

  let linesUpdate = {};
  if (newItems || newMoneyAccountId) {
    const moneyAccountId = newMoneyAccountId ?? existing.moneyAccountId;
    if (!moneyAccountId) throw new Error(`${voucherType} voucher ${existing._id} has no money account.`);
    if (newMoneyAccountId) await assertIsMoneyAccount(newMoneyAccountId);
    const items = newItems ?? itemsOf({ ...existing, voucherType });
    linesUpdate = { moneyAccountId, ...(await checkBalancedLines(buildMoneyVoucherLines(voucherType, moneyAccountId, items))) };
  }
  const { $set, $unset } = headerChanges(header);
  return saveDraftEdit(actor, existing, { $set: { ...$set, ...linesUpdate }, $unset }, { reason, version });
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

/** A recorded voucher's date, memo and balanced lines: what an update request replaces. */
export interface CorrectedVoucherContent {
  voucherDate: string;
  memo: string;
  lines: LedgerLine[];
  total: number;
}

/**
 * Corrects a recorded voucher for an approved update request, inside the request's transaction: reverses its current
 * ledger entry (dated today), records the corrected entry, and saves the voucher with the new details and history.
 * The voucher stays recorded and keeps its number. `expectedVersion` refuses it if the voucher changed since the
 * request was made, such as being reversed. Returns the two new ledger entries.
 */
export async function correctRecordedVoucher(
  actor: Actor,
  voucherId: string,
  corrected: CorrectedVoucherContent,
  context: { requestNumber: string; session: ClientSession },
): Promise<{ reversalEntryId: string; correctedEntryId: string }> {
  const existing = await requireJournalVoucher(voucherId);
  assertStatus(existing, 'recorded', 'corrected');
  const ledgerEntryId = existing.ledgerEntryId;
  if (!ledgerEntryId) throw new Error(`Recorded voucher ${existing._id} has no ledger entry.`);
  const { session, requestNumber } = context;

  const reversal = await reverseEntry(actor, ledgerEntryId, session, { memo: `${requestNumber}: reverses ${existing.number} ${existing.memo}` });
  const correctedEntry = await postEntry(actor, {
    entryDate: corrected.voucherDate,
    memo: `${existing.number} ${corrected.memo} (corrected by ${requestNumber})`,
    source: { type: JOURNAL_VOUCHER_RESOURCE, id: existing._id },
    lines: corrected.lines,
  }, session);

  const saved = await changeJournalVoucher(existing._id, {
    $set: { voucherDate: corrected.voucherDate, memo: corrected.memo, lines: corrected.lines, total: corrected.total, ledgerEntryId: correctedEntry._id },
  }, { actorId: actor.user._id, expectedVersion: existing.version, session });
  await writeRecordHistory(historyRef(existing._id), { action: 'updated', actor, before: existing, after: saved }, session);
  await recordAudit({ action: 'journalVoucher.corrected', ...auditFields(actor, saved) }, session);
  return { reversalEntryId: reversal._id, correctedEntryId: correctedEntry._id };
}

export async function getJournalVoucherHistory(actor: Actor, voucherId: string, page: PageRequest) {
  await requireJournalVoucher(voucherId);
  const history = await listRecordHistory(historyRef(voucherId), page);
  return { ...history, entries: redactHistory(history.entries, await fieldRulesFor(actor)) };
}
