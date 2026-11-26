import type { ClientSession, UpdateQuery } from 'mongoose';
import { ApiError } from '../../../lib/errors.js';
import { escapeRegex, pageOffset, type PageRequest } from '../../../lib/query.js';
import { changeRecord } from '../../../lib/records/recordWrites.js';
import { JournalVoucher, VoucherCounter, type JournalVoucherDoc, type JournalVoucherStatus, type VoucherType } from '../models/journalVoucher.js';

export type NewJournalVoucherRecord = Pick<JournalVoucherDoc, '_id' | 'voucherType' | 'number' | 'voucherDate' | 'memo' | 'party' | 'reference' | 'moneyAccountId' | 'linkedDocument' | 'lines' | 'total'>;

export const journalVoucherNotFound = () => new ApiError(404, 'unknown_journal_voucher', 'No such journal voucher.');

/** Each type has its own number series. The journal series keeps the id it had before other types existed. */
const COUNTER_IDS: Record<VoucherType, string> = { journal: 'journalVoucher', payment: 'paymentVoucher', receipt: 'receiptVoucher' };

/** Vouchers saved before types existed have no voucherType, and are journal vouchers. */
const typeFilter = (voucherType: VoucherType) => (voucherType === 'journal' ? { voucherType: { $in: ['journal' as const, null] } } : { voucherType });

export interface JournalVoucherListFilter {
  voucherType?: VoucherType;
  status?: JournalVoucherStatus;
  /** First and last voucher date to include, YYYY-MM-DD. */
  from?: string;
  to?: string;
  /** The start of a voucher number, or any part of its memo or party. */
  search?: string;
}

function listFilter({ voucherType, status, from, to, search }: JournalVoucherListFilter) {
  const dateRange = { ...(from && { $gte: from }), ...(to && { $lte: to }) };
  return {
    ...(voucherType && typeFilter(voucherType)),
    ...(status && { status }),
    ...(Object.keys(dateRange).length > 0 && { voucherDate: dateRange }),
    ...(search && { $or: [{ number: { $regex: `^${escapeRegex(search)}`, $options: 'i' } }, { memo: { $regex: escapeRegex(search), $options: 'i' } }, { party: { $regex: escapeRegex(search), $options: 'i' } }] }),
  };
}

export async function findJournalVouchersPage({ voucherType, status, from, to, search, ...page }: PageRequest & JournalVoucherListFilter) {
  const filter = listFilter({ voucherType, status, from, to, search });
  const [vouchers, total] = await Promise.all([
    JournalVoucher.find(filter).sort({ voucherDate: -1, number: -1 }).skip(pageOffset(page)).limit(page.pageSize).lean(),
    JournalVoucher.countDocuments(filter),
  ]);
  return { vouchers, total };
}

export const findJournalVoucherById = (voucherId: string) => JournalVoucher.findById(voucherId).lean();

/** The next number in the series. Taken outside the voucher's transaction, so a failed save leaves a gap rather than a repeat. */
export async function takeNextVoucherNumber(voucherType: VoucherType): Promise<number> {
  const counter = await VoucherCounter.findOneAndUpdate({ _id: COUNTER_IDS[voucherType] }, { $inc: { lastNumber: 1 } }, { upsert: true, returnDocument: 'after' }).lean();
  if (!counter) throw new Error('The voucher counter returned nothing.');
  return counter.lastNumber;
}

export async function insertJournalVoucher(record: NewJournalVoucherRecord, createdBy: string, session: ClientSession): Promise<JournalVoucherDoc> {
  const [created] = await JournalVoucher.create([{ ...record, status: 'draft', createdBy, updatedBy: createdBy }], { session });
  if (!created) throw new Error('Creating the journal voucher returned nothing.');
  return created.toObject();
}

/** Saves a change. `expectedVersion` refuses it if someone changed the voucher since it was read, which also stops two approvals racing. */
export function changeJournalVoucher(voucherId: string, update: UpdateQuery<JournalVoucherDoc>, context: { actorId: string; expectedVersion: number; session: ClientSession }) {
  return changeRecord(JournalVoucher, voucherId, update, context, journalVoucherNotFound);
}

/** Submitted vouchers, oldest submission first: those made by someone other than `notMadeBy`, or only those made by `madeBy`. */
export async function findSubmittedJournalVouchers(creator: { notMadeBy: string } | { madeBy: string }, limit: number) {
  const filter = { status: 'submitted' as const, createdBy: 'madeBy' in creator ? creator.madeBy : { $ne: creator.notMadeBy } };
  const [vouchers, total] = await Promise.all([
    JournalVoucher.find(filter).sort({ submittedAt: 1, number: 1 }).limit(limit).lean(),
    JournalVoucher.countDocuments(filter),
  ]);
  return { vouchers, total };
}

/** Reversed vouchers, most recently reversed first, for the Change history screen. */
export const findReversedJournalVouchers = (limit: number) => JournalVoucher.find({ status: 'reversed' }).sort({ reversedAt: -1 }).limit(limit).lean();

/** How much of each document its vouchers settle: `recorded` counts only recorded ones; `committed` adds drafts and those waiting. */
export interface SettledAmounts {
  recorded: number;
  committed: number;
}

/** Settled amounts per invoice or bill id, in the document's currency. Reversed vouchers count for nothing. */
export async function sumSettledAmounts(documentIds: string[], session?: ClientSession): Promise<Map<string, SettledAmounts>> {
  const rows = await JournalVoucher.aggregate<{ _id: { id: string; status: JournalVoucherStatus }; amount: number }>([
    { $match: { 'linkedDocument.id': { $in: documentIds }, status: { $in: ['draft', 'submitted', 'recorded'] }, deletedAt: { $exists: false } } },
    { $group: { _id: { id: '$linkedDocument.id', status: '$status' }, amount: { $sum: '$linkedDocument.amount' } } },
  ]).session(session ?? null);
  const settled = new Map<string, SettledAmounts>(documentIds.map((id) => [id, { recorded: 0, committed: 0 }]));
  for (const row of rows) {
    const amounts = settled.get(row._id.id);
    if (!amounts) continue;
    amounts.committed += row.amount;
    if (row._id.status === 'recorded') amounts.recorded += row.amount;
  }
  return settled;
}

/** The vouchers that settle one document, newest first, for its page. */
export const findVouchersLinkedTo = (documentId: string) =>
  JournalVoucher.find({ 'linkedDocument.id': documentId }).sort({ voucherDate: -1, number: -1 }).lean();
