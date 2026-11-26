import type { PipelineStage } from 'mongoose';
import { ApiError } from '../../../lib/errors.js';
import { pageOffset, type PageRequest } from '../../../lib/query.js';
import type { Actor } from '../../master/access/caller.js';
import { readFieldRules } from '../../master/records/fieldSecurity.service.js';
import { ACCOUNTS_MODULE_KEY } from '../accountsModule.js';
import { getTrialBalance } from '../ledger/ledger.service.js';
import { findLedgerAccountById } from '../ledgerAccount/ledgerAccount.repository.js';
import { Bill } from '../models/bill.js';
import { Invoice } from '../models/invoice.js';
import { JournalVoucher } from '../models/journalVoucher.js';
import { LedgerEntry } from '../models/ledgerEntry.js';
import { NORMAL_BALANCE } from '../models/ledgerAccount.js';
import { PayrollRun } from '../models/payrollRun.js';
import { EmployeeLoan } from '../models/employeeLoan.js';
import { StaffPayout } from '../models/staffPayout.js';
import { LedgerAccount } from '../models/ledgerAccount.js';
import { NOT_OFFICE_EXPENSES } from '../postingAccounts.js';

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

/** Payroll entries name this source type, and the payroll run's protected field holding each person's pay. */
const PAYROLL_RUN_SOURCE = 'payrollRun';
const PAYROLL_SALARY_FIELD = 'lines';

/** The record each entry came from, by type, so a line shows "PV-0001" instead of an id. */
const SOURCE_NUMBERS: Record<string, (ids: string[]) => Promise<{ _id: string; number: string }[]>> = {
  journalVoucher: (ids) => JournalVoucher.find({ _id: { $in: ids } }).select('number').lean(),
  invoice: (ids) => Invoice.find({ _id: { $in: ids } }).select('number').lean(),
  bill: (ids) => Bill.find({ _id: { $in: ids } }).select('number').lean(),
  payrollRun: (ids) => PayrollRun.find({ _id: { $in: ids } }).select('number').lean(),
  employeeLoan: (ids) => EmployeeLoan.find({ _id: { $in: ids } }).select('number').lean(),
  staffPayout: (ids) => StaffPayout.find({ _id: { $in: ids } }).select('number').lean(),
};

export async function sourceNumbers(sources: { type: string; id: string }[]): Promise<Map<string, string>> {
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

const LINE_ORDER = { entryDate: 1, createdAt: 1, _id: 1, lineIndex: 1 } as const;

/**
 * The account's lines in the period, one document per line, oldest first. A payroll run's entry has a line per person
 * with their gross, so for someone whose profile hides payroll lines, each payroll entry's lines on the account are
 * added into one line that shows only the entry's memo ("PR-0001 salaries, November 2026"). Doing it here, before any
 * paging or counting, keeps pages, totals and running balances the same for everyone.
 */
function accountLineStages(match: Record<string, unknown>, accountId: string, hidePayPerPerson: boolean): PipelineStage[] {
  const lines: PipelineStage[] = [
    { $match: match },
    { $unwind: { path: '$lines', includeArrayIndex: 'lineIndex' } },
    { $match: { 'lines.accountId': accountId } },
  ];
  if (!hidePayPerPerson) return [...lines, { $sort: LINE_ORDER }];
  const isPayroll = { $eq: ['$source.type', PAYROLL_RUN_SOURCE] };
  return [
    ...lines,
    {
      $group: {
        // Every payroll line of one entry shares a key; any other line keeps its own.
        _id: { entryId: '$_id', line: { $cond: [isPayroll, -1, '$lineIndex'] } },
        entryDate: { $first: '$entryDate' },
        createdAt: { $first: '$createdAt' },
        memo: { $first: '$memo' },
        source: { $first: '$source' },
        reversalOf: { $first: '$reversalOf' },
        lineIndex: { $min: '$lineIndex' },
        debit: { $sum: '$lines.debit' },
        credit: { $sum: '$lines.credit' },
        lineMemo: { $first: '$lines.memo' },
      },
    },
    {
      $project: {
        _id: '$_id.entryId',
        entryDate: 1,
        createdAt: 1,
        memo: 1,
        source: 1,
        reversalOf: 1,
        lineIndex: 1,
        lines: {
          debit: { $max: [0, { $subtract: ['$debit', '$credit'] }] },
          credit: { $max: [0, { $subtract: ['$credit', '$debit'] }] },
          memo: { $cond: [isPayroll, '$$REMOVE', '$lineMemo'] },
        },
      },
    },
    { $sort: LINE_ORDER },
  ];
}

/**
 * One account's lines in the period, a page at a time. `opening` is the balance before `from`; each line's `balance`
 * is the running balance after it, on the debit side (debits minus credits), whatever page it is on. The account's
 * `normalBalance` says which side its balance usually sits on, for showing it. `payPerPersonHidden` says payroll
 * entries were added into one line each, because the caller's profile hides salaries.
 */
export async function getGeneralLedger(actor: Actor, { accountId, from, to, ...page }: GeneralLedgerQuery) {
  const account = await findLedgerAccountById(accountId);
  if (!account) throw new ApiError(404, 'unknown_ledger_account', 'No such account in the chart of accounts.');
  const payPerPersonHidden = (await readFieldRules(actor, ACCOUNTS_MODULE_KEY, PAYROLL_RUN_SOURCE)).hidden.includes(PAYROLL_SALARY_FIELD);

  const lineStages = accountLineStages({ 'lines.accountId': accountId, entryDate: { $gte: from, $lte: to } }, accountId, payPerPersonHidden);
  const [opening, period, beforePage, rows, total] = await Promise.all([
    sumAccount(accountId, { before: from }),
    sumAccount(accountId, { from, to }),
    // Lines on earlier pages, so the running balance continues across pages.
    LedgerEntry.aggregate<{ net: number }>([
      ...lineStages,
      { $limit: pageOffset(page) || 1 },
      { $group: { _id: null, net: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } } } },
    ]),
    LedgerEntry.aggregate<{ _id: string; entryDate: string; memo: string; source: { type: string; id: string }; reversalOf?: string; line: { debit: number; credit: number; memo?: string } }>([
      ...lineStages,
      { $skip: pageOffset(page) },
      { $limit: page.pageSize },
      { $project: { entryDate: 1, memo: 1, source: 1, reversalOf: 1, line: '$lines' } },
    ]),
    LedgerEntry.aggregate<{ count: number }>([...lineStages, { $count: 'count' }]),
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
    payPerPersonHidden,
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

/**
 * Office running costs in a period: every expense account except people costs and book entries, with each line that
 * reached it (from bills, payments or journal vouchers), newest first. Read from the ledger, so reversals net out.
 */
export async function getOfficeExpenses(from: string, to: string) {
  const accounts = await LedgerAccount.find({ type: 'expense', _id: { $nin: NOT_OFFICE_EXPENSES } }).sort({ code: 1 }).lean();
  const accountIds = accounts.map((account) => account._id);
  const rows = await LedgerEntry.aggregate<{ _id: string; entryDate: string; memo: string; source: { type: string; id: string }; reversalOf?: string; line: { accountId: string; debit: number; credit: number; memo?: string } }>([
    { $match: { 'lines.accountId': { $in: accountIds }, entryDate: { $gte: from, $lte: to } } },
    { $unwind: '$lines' },
    { $match: { 'lines.accountId': { $in: accountIds } } },
    { $sort: { entryDate: -1, createdAt: -1 } },
    { $project: { entryDate: 1, memo: 1, source: 1, reversalOf: 1, line: '$lines' } },
  ]);
  const numbers = await sourceNumbers(rows.map((row) => row.source));
  const byAccount = new Map<string, number>();
  for (const row of rows) byAccount.set(row.line.accountId, (byAccount.get(row.line.accountId) ?? 0) + row.line.debit - row.line.credit);
  const categories = accounts
    .map((account) => ({ accountId: account._id, code: account.code, name: account.name, amount: byAccount.get(account._id) ?? 0 }))
    .filter((category) => category.amount !== 0);
  return {
    from,
    to,
    total: categories.reduce((sum, category) => sum + category.amount, 0),
    categories,
    lines: rows.map((row) => ({
      entryId: row._id,
      entryDate: row.entryDate,
      accountId: row.line.accountId,
      memo: row.line.memo ?? row.memo,
      entryMemo: row.memo,
      source: { ...row.source, number: numbers.get(row.source.id) },
      isReversal: Boolean(row.reversalOf),
      amount: row.line.debit - row.line.credit,
    })),
  };
}
