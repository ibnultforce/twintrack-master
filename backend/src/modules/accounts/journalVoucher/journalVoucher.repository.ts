import type { ClientSession, UpdateQuery } from 'mongoose';
import { ApiError } from '../../../lib/errors.js';
import { pageOffset, type PageRequest } from '../../../lib/query.js';
import { changeRecord } from '../../../lib/records/recordWrites.js';
import { JournalVoucher, VoucherCounter, type JournalVoucherDoc, type JournalVoucherStatus } from '../models/journalVoucher.js';

export type NewJournalVoucherRecord = Pick<JournalVoucherDoc, '_id' | 'number' | 'voucherDate' | 'memo' | 'lines' | 'total'>;

export const journalVoucherNotFound = () => new ApiError(404, 'unknown_journal_voucher', 'No such journal voucher.');

const COUNTER_ID = 'journalVoucher';

export interface JournalVoucherListFilter {
  status?: JournalVoucherStatus;
}

export async function findJournalVouchersPage({ status, ...page }: PageRequest & JournalVoucherListFilter) {
  const filter = status ? { status } : {};
  const [vouchers, total] = await Promise.all([
    JournalVoucher.find(filter).sort({ voucherDate: -1, number: -1 }).skip(pageOffset(page)).limit(page.pageSize).lean(),
    JournalVoucher.countDocuments(filter),
  ]);
  return { vouchers, total };
}

export const findJournalVoucherById = (voucherId: string) => JournalVoucher.findById(voucherId).lean();

/** The next number in the series. Taken outside the voucher's transaction, so a failed save leaves a gap rather than a repeat. */
export async function takeNextVoucherNumber(): Promise<number> {
  const counter = await VoucherCounter.findOneAndUpdate({ _id: COUNTER_ID }, { $inc: { lastNumber: 1 } }, { upsert: true, returnDocument: 'after' }).lean();
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
