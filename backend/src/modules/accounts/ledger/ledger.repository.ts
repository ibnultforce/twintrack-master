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

/** One account's movements around a period: its balance before the period, and its debits and credits in it. */
export interface PeriodTotals {
  accountId: string;
  /** Debits minus credits on lines dated before `from`. */
  opening: number;
  /** Debits dated from `from` to `to`. */
  debit: number;
  /** Credits dated from `from` to `to`. */
  credit: number;
}

/** Sums these accounts' lines up to `to` (YYYY-MM-DD), split into before `from` and from `from` on. */
export function sumLinesForPeriod(accountIds: string[], from: string, to: string): Promise<PeriodTotals[]> {
  const isBefore = { $lt: ['$entryDate', from] };
  return LedgerEntry.aggregate<PeriodTotals>([
    { $match: { 'lines.accountId': { $in: accountIds }, entryDate: { $lte: to } } },
    { $unwind: '$lines' },
    { $match: { 'lines.accountId': { $in: accountIds } } },
    {
      $group: {
        _id: '$lines.accountId',
        opening: { $sum: { $cond: [isBefore, { $subtract: ['$lines.debit', '$lines.credit'] }, 0] } },
        debit: { $sum: { $cond: [isBefore, 0, '$lines.debit'] } },
        credit: { $sum: { $cond: [isBefore, 0, '$lines.credit'] } },
      },
    },
    { $project: { _id: 0, accountId: '$_id', opening: 1, debit: 1, credit: 1 } },
  ]);
}

/** Debit and credit totals across the whole ledger for just these accounts. */
export function sumLinesForAccounts(accountIds: string[]): Promise<AccountTotals[]> {
  return LedgerEntry.aggregate<AccountTotals>([
    { $match: { 'lines.accountId': { $in: accountIds } } },
    { $unwind: '$lines' },
    { $match: { 'lines.accountId': { $in: accountIds } } },
    { $group: { _id: '$lines.accountId', debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' } } },
    { $project: { _id: 0, accountId: '$_id', debit: 1, credit: 1 } },
  ]);
}
