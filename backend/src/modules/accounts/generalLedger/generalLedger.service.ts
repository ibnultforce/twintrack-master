import { ApiError } from '../../../lib/errors.js';
import { pageOffset, type PageRequest } from '../../../lib/query.js';
import { getTrialBalance } from '../ledger/ledger.service.js';
import { findLedgerAccountById } from '../ledgerAccount/ledgerAccount.repository.js';
import { Bill } from '../models/bill.js';
import { Invoice } from '../models/invoice.js';
import { JournalVoucher } from '../models/journalVoucher.js';
import { LedgerEntry } from '../models/ledgerEntry.js';
import { NORMAL_BALANCE } from '../models/ledgerAccount.js';
import { PayrollRun } from '../models/payrollRun.js';

/*
 * The general ledger: every line posted to one account in a period, oldest first, with the balance after each line.
 * Read straight from ledger entries, so it always agrees with the trial balance.
 */

export interface GeneralLedgerQuery extends PageRequest {
  accountId: string;
  /** First and last entry date to include, YYYY-MM-DD. */
  from: string;
  to: string;
}

/** The record each entry came from, by type, so a line shows "PV-0001" instead of an id. */
const SOURCE_NUMBERS: Record<string, (ids: string[]) => Promise<{ _id: string; number: string }[]>> = {
  journalVoucher: (ids) => JournalVoucher.find({ _id: { $in: ids } }).select('number').lean(),
  invoice: (ids) => Invoice.find({ _id: { $in: ids } }).select('number').lean(),
  bill: (ids) => Bill.find({ _id: { $in: ids } }).select('number').lean(),
  payrollRun: (ids) => PayrollRun.find({ _id: { $in: ids } }).select('number').lean(),
};

async function sourceNumbers(sources: { type: string; id: string }[]): Promise<Map<string, string>> {
  const byType = new Map<string, string[]>();
  for (const source of sources) byType.set(source.type, [...(byType.get(source.type) ?? []), source.id]);
  const found = await Promise.all([...byType].map(async ([type, ids]) => (SOURCE_NUMBERS[type] ? SOURCE_NUMBERS[type](ids) : [])));
  return new Map(found.flat().map((record) => [record._id, record.number]));
}

/** Debits and credits on the account in a date range (either end open), from the ledger alone. */
async function sumAccount(accountId: string, range: { before?: string; from?: string; to?: string }) {
  const dates = { ...(range.before && { $lt: range.before }), ...(range.from && { $gte: range.from }), ...(range.to && { $lte: range.to }) };
  const [totals] = await LedgerEntry.aggregate<{ debit: number; credit: number }>([
    { $match: { 'lines.accountId': accountId, entryDate: dates } },
    { $unwind: '$lines' },
    { $match: { 'lines.accountId': accountId } },
    { $group: { _id: null, debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' } } },
  ]);
  return { debit: totals?.debit ?? 0, credit: totals?.credit ?? 0 };
}

/**
 * One account's lines in the period, a page at a time. `opening` is the balance before `from`; each line's `balance`
 * is the running balance after it, on the debit side (debits minus credits), whatever page it is on. The account's
 * `normalBalance` says which side its balance usually sits on, for showing it.
 */
export async function getGeneralLedger({ accountId, from, to, ...page }: GeneralLedgerQuery) {
  const account = await findLedgerAccountById(accountId);
  if (!account) throw new ApiError(404, 'unknown_ledger_account', 'No such account in the chart of accounts.');

  const match = { 'lines.accountId': accountId, entryDate: { $gte: from, $lte: to } };
  const [opening, period, beforePage, rows, total] = await Promise.all([
    sumAccount(accountId, { before: from }),
    sumAccount(accountId, { from, to }),
    // Lines on earlier pages, so the running balance continues across pages.
    LedgerEntry.aggregate<{ net: number }>([
      { $match: match },
      { $sort: { entryDate: 1, createdAt: 1, _id: 1 } },
      { $unwind: '$lines' },
      { $match: { 'lines.accountId': accountId } },
      { $limit: pageOffset(page) || 1 },
      { $group: { _id: null, net: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } } } },
    ]),
    LedgerEntry.aggregate<{ _id: string; entryDate: string; memo: string; source: { type: string; id: string }; reversalOf?: string; line: { debit: number; credit: number; memo?: string } }>([
      { $match: match },
      { $sort: { entryDate: 1, createdAt: 1, _id: 1 } },
      { $unwind: '$lines' },
      { $match: { 'lines.accountId': accountId } },
      { $skip: pageOffset(page) },
      { $limit: page.pageSize },
      { $project: { entryDate: 1, memo: 1, source: 1, reversalOf: 1, line: '$lines' } },
    ]),
    LedgerEntry.aggregate<{ count: number }>([{ $match: match }, { $unwind: '$lines' }, { $match: { 'lines.accountId': accountId } }, { $count: 'count' }]),
  ]);

  const openingBalance = opening.debit - opening.credit;
  let running = openingBalance + (pageOffset(page) > 0 ? beforePage[0]?.net ?? 0 : 0);
  const numbers = await sourceNumbers(rows.map((row) => row.source));
  return {
    account: { id: account._id, code: account.code, name: account.name, type: account.type, normalBalance: NORMAL_BALANCE[account.type] },
    from,
    to,
    opening: openingBalance,
    totalDebit: period.debit,
    totalCredit: period.credit,
    closing: openingBalance + period.debit - period.credit,
    total: total[0]?.count ?? 0,
    page: page.page,
    pageSize: page.pageSize,
    lines: rows.map((row) => {
      running += row.line.debit - row.line.credit;
      return {
        entryId: row._id,
        entryDate: row.entryDate,
        memo: row.line.memo ?? row.memo,
        entryMemo: row.memo,
        source: { ...row.source, number: numbers.get(row.source.id) },
        isReversal: Boolean(row.reversalOf),
        debit: row.line.debit,
        credit: row.line.credit,
        balance: running,
      };
    }),
  };
}

/** The trial balance up to a date: every account's debits, credits and balance, and the grand totals. */
export async function getTrialBalanceView(to?: string) {
  const balance = await getTrialBalance(to);
  return { to, ...balance };
}
