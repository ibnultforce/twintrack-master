import { VoucherCounter } from './models/journalVoucher.js';

const NUMBER_DIGITS = 4;

/**
 * The next number in a series, such as INV-0001 or B-0001. Taken outside the record's transaction, so a failed save
 * leaves a gap rather than a repeat. Every Accounts series shares one counters collection, keyed by `series`.
 */
export async function takeNextDocumentNumber(series: string, prefix: string): Promise<string> {
  const counter = await VoucherCounter.findOneAndUpdate({ _id: series }, { $inc: { lastNumber: 1 } }, { upsert: true, returnDocument: 'after' }).lean();
  if (!counter) throw new Error(`The ${series} counter returned nothing.`);
  return `${prefix}${String(counter.lastNumber).padStart(NUMBER_DIGITS, '0')}`;
}
