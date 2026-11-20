import type { ClientSession } from 'mongoose';
import { LedgerEntry, type LedgerEntryDoc } from '../models/ledgerEntry.js';

export type NewLedgerEntryRecord = Omit<LedgerEntryDoc, 'createdAt' | 'reversedBy'>;

/** Debit and credit totals for one account across the whole ledger, or up to a date. */
export interface AccountTotals {
  accountId: string;
  debit: number;
  credit: number;
}

/** Whether any ledger line, in any entry, names this account. */
export const accountHasLedgerLines = async (accountId: string) => Boolean(await LedgerEntry.exists({ 'lines.accountId': accountId }));

/** Debits minus credits across every line that names this account: its balance, from the ledger alone. */
export async function findAccountBalance(accountId: string): Promise<number> {
  const [totals] = await LedgerEntry.aggregate<{ balance: number }>([
    { $match: { 'lines.accountId': accountId } },
    { $unwind: '$lines' },
    { $match: { 'lines.accountId': accountId } },
    { $group: { _id: null, balance: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } } } },
  ]);
  return totals?.balance ?? 0;
}

export const findLedgerEntryById = (entryId: string, session?: ClientSession) => LedgerEntry.findById(entryId).session(session ?? null).lean();

export async function insertLedgerEntry(record: NewLedgerEntryRecord, session: ClientSession): Promise<LedgerEntryDoc> {
  const [created] = await LedgerEntry.create([record], { session });
  if (!created) throw new Error('Creating the ledger entry returned nothing.');
  return created.toObject();
}

/**
 * Marks an entry as reversed, only if nobody has reversed it yet. Returns null when it was already reversed, so two
 * reversals running at once can't both succeed.
 */
export const markLedgerEntryReversed = (entryId: string, reversalId: string, session: ClientSession) =>
  LedgerEntry.findOneAndUpdate({ _id: entryId, reversedBy: { $exists: false } }, { $set: { reversedBy: reversalId } }, { returnDocument: 'after', session }).lean();

/** Sums every line per account. `upToDate` (YYYY-MM-DD) leaves out entries dated after it. */
export function sumLinesByAccount(upToDate?: string, session?: ClientSession): Promise<AccountTotals[]> {
  return LedgerEntry.aggregate<AccountTotals>([
    ...(upToDate ? [{ $match: { entryDate: { $lte: upToDate } } }] : []),
    { $unwind: '$lines' },
    { $group: { _id: '$lines.accountId', debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' } } },
    { $project: { _id: 0, accountId: '$_id', debit: 1, credit: 1 } },
    { $sort: { accountId: 1 } },
  ]).session(session ?? null);
}
