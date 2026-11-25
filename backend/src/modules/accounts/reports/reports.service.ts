import { dayBefore, financialYearOf, financialYearRange, monthRange, monthsOfFinancialYear } from '../financialYear.js';
import { sumCashCounterparts, sumLinesByAccountAndMonth, sumLinesByAccountInRange, sumLinesForPeriod, type AccountTotals } from '../ledger/ledger.repository.js';
import { findCashAndBankAccounts } from '../ledgerAccount/ledgerAccount.repository.js';
import { LedgerAccount, NORMAL_BALANCE, type LedgerAccountDoc, type LedgerAccountType } from '../models/ledgerAccount.js';
import { POSTING_ACCOUNTS } from '../postingAccounts.js';

/*
 * The financial reports and the dashboard, read straight from ledger lines, so they always agree with the trial
 * balance. Amounts are paisa on each account's normal side: income, liabilities and equity as positive credits,
 * assets and expenses as positive debits. Nothing here writes.
 */

export interface ReportRow {
  accountId: string;
  code: string;
  name: string;
  amount: number;
}

export interface ReportSection {
  key: string;
  label: string;
  rows: ReportRow[];
  total: number;
}

type Chart = Map<string, LedgerAccountDoc>;

const TOP_EXPENSE_COUNT = 5;

/** Accounts bought or sold as investments: cash spent on them is investing, not running the business. */
const INVESTING_ACCOUNTS: ReadonlySet<string> = new Set([POSTING_ACCOUNTS.fixedAssets, POSTING_ACCOUNTS.accumulatedDepreciation]);

const sumAmounts = (amounts: number[]) => amounts.reduce((total, amount) => total + amount, 0);

/** An account's figure on its normal side: debits minus credits for assets and expenses, the other way for the rest. */
const onNormalSide = (type: LedgerAccountType, { debit, credit }: Pick<AccountTotals, 'debit' | 'credit'>) =>
  NORMAL_BALANCE[type] === 'debit' ? debit - credit : credit - debit;

const loadChart = async (): Promise<Chart> => new Map((await LedgerAccount.find().lean()).map((account) => [account._id, account]));

const byCode = (first: ReportRow, second: ReportRow) => first.code.localeCompare(second.code);

/** The rows of one account type, by code, leaving out accounts with nothing on them. */
function rowsOfType(chart: Chart, totals: AccountTotals[], type: LedgerAccountType): ReportRow[] {
  return totals
    .flatMap((totalsRow) => {
      const account = chart.get(totalsRow.accountId);
      if (account?.type !== type) return [];
      return [{ accountId: account._id, code: account.code, name: account.name, amount: onNormalSide(type, totalsRow) }];
    })
    .filter((row) => row.amount !== 0)
    .sort(byCode);
}

const section = (key: string, label: string, rows: ReportRow[]): ReportSection => ({ key, label, rows, total: sumAmounts(rows.map((row) => row.amount)) });

/** Income less expenses on a set of totals. */
function profitOf(chart: Chart, totals: AccountTotals[]) {
  const income = sumAmounts(rowsOfType(chart, totals, 'income').map((row) => row.amount));
  const expenses = sumAmounts(rowsOfType(chart, totals, 'expense').map((row) => row.amount));
  return { income, expenses, profit: income - expenses };
}

/** Profit and loss for a period: each income and expense account's movement in it, and the net profit. */
export async function getProfitAndLoss(from: string, to: string) {
  const [chart, totals] = await Promise.all([loadChart(), sumLinesByAccountInRange({ from, to })]);
  const income = section('income', 'Income', rowsOfType(chart, totals, 'income'));
  const expenses = section('expenses', 'Expenses', rowsOfType(chart, totals, 'expense'));
  return { from, to, income, expenses, netProfit: income.total - expenses.total };
}

/**
 * The balance sheet on a date. There are no year-end closing entries, so profit not yet moved into equity shows as
 * two equity lines: this financial year's and earlier years'. `difference` is assets less liabilities and equity,
 * which stays zero while the ledger balances.
 */
export async function getBalanceSheet(to: string) {
  const financialYear = financialYearOf(to);
  const [chart, upToDate, beforeYear] = await Promise.all([
    loadChart(),
    sumLinesByAccountInRange({ to }),
    sumLinesByAccountInRange({ to: dayBefore(financialYearRange(financialYear).from) }),
  ]);
  const assets = section('assets', 'Assets', rowsOfType(chart, upToDate, 'asset'));
  const liabilities = section('liabilities', 'Liabilities', rowsOfType(chart, upToDate, 'liability'));
  const equityAccounts = section('equity', 'Equity', rowsOfType(chart, upToDate, 'equity'));
  const earlierProfit = profitOf(chart, beforeYear).profit;
  const yearProfit = profitOf(chart, upToDate).profit - earlierProfit;
  const profitRows = [
    { key: 'earlierProfit', label: 'Profit from earlier years', amount: earlierProfit },
    { key: 'yearProfit', label: 'Profit this financial year', amount: yearProfit },
  ].filter((row) => row.amount !== 0);
  const equityTotal = equityAccounts.total + earlierProfit + yearProfit;
  return {
    to,
    financialYear,
    assets,
    liabilities,
    equity: { ...equityAccounts, profitRows, total: equityTotal },
    totalLiabilitiesAndEquity: liabilities.total + equityTotal,
    difference: assets.total - liabilities.total - equityTotal,
  };
}

type CashFlowKey = 'operating' | 'investing' | 'financing';

const CASH_FLOW_LABELS: Record<CashFlowKey, string> = {
  operating: 'Running the business',
  investing: 'Buying and selling assets',
  financing: 'Owners and financing',
};

const cashFlowKeyOf = (account: LedgerAccountDoc): CashFlowKey => {
  if (INVESTING_ACCOUNTS.has(account._id)) return 'investing';
  return account.type === 'equity' ? 'financing' : 'operating';
};

/**
 * The cash flow for a period, by the direct method: every movement in the cash and bank accounts, sorted by the
 * account on the other side. Money in is positive. The sections add up to closing less opening cash, so
 * `difference` stays zero.
 */
export async function getCashFlow(from: string, to: string) {
  const cashIds = (await findCashAndBankAccounts()).map((account) => account._id);
  const [chart, counterparts, cashTotals] = await Promise.all([loadChart(), sumCashCounterparts(cashIds, from, to), sumLinesForPeriod(cashIds, from, to)]);

  const rowsByKey: Record<CashFlowKey, ReportRow[]> = { operating: [], investing: [], financing: [] };
  for (const { accountId, amount } of counterparts) {
    const account = chart.get(accountId);
    if (!account || amount === 0) continue;
    rowsByKey[cashFlowKeyOf(account)].push({ accountId, code: account.code, name: account.name, amount });
  }
  const sections = (Object.keys(CASH_FLOW_LABELS) as CashFlowKey[]).map((key) => section(key, CASH_FLOW_LABELS[key], rowsByKey[key].sort(byCode)));
  const opening = sumAmounts(cashTotals.map((row) => row.opening));
  const closing = opening + sumAmounts(cashTotals.map((row) => row.debit - row.credit));
  const netChange = sumAmounts(sections.map((each) => each.total));
  return { from, to, opening, sections, netChange, closing, difference: closing - opening - netChange };
}

/**
 * The Accounts dashboard for a month: money in cash and bank, what clients owe and what is owed to vendors at its
 * end, the month's and the financial year's profit so far, each month of the year up to it, and its largest costs.
 */
export async function getDashboard(month: string) {
  const { from, to } = monthRange(month);
  const financialYear = financialYearOf(month);
  const [chart, cashAccounts, atMonthEnd] = await Promise.all([loadChart(), findCashAndBankAccounts(), sumLinesByAccountInRange({ to })]);
  const profitAccountIds = [...chart.values()].filter((account) => account.type === 'income' || account.type === 'expense').map((account) => account._id);
  const byMonth = await sumLinesByAccountAndMonth(profitAccountIds, financialYearRange(financialYear).from, to);

  const balances = new Map(atMonthEnd.map((row) => [row.accountId, row]));
  const balanceOf = (accountId: string) => {
    const account = chart.get(accountId);
    const totals = balances.get(accountId);
    return account && totals ? onNormalSide(account.type, totals) : 0;
  };
  const cash = cashAccounts.map((account) => ({ accountId: account._id, code: account.code, name: account.name, kind: account.cashOrBank, amount: balanceOf(account._id) }));

  const monthTotals = (each: string): AccountTotals[] => byMonth.filter((row) => row.month === each);
  const trend = monthsOfFinancialYear(financialYear)
    .filter((each) => each <= month)
    .map((each) => ({ month: each, ...profitOf(chart, monthTotals(each)) }));
  const thisMonth = profitOf(chart, monthTotals(month));
  const topExpenses = rowsOfType(chart, monthTotals(month), 'expense')
    .sort((first, second) => second.amount - first.amount)
    .slice(0, TOP_EXPENSE_COUNT);

  return {
    month,
    from,
    to,
    financialYear,
    cash: { accounts: cash, total: sumAmounts(cash.map((account) => account.amount)) },
    receivable: balanceOf(POSTING_ACCOUNTS.receivable),
    payable: balanceOf(POSTING_ACCOUNTS.payable),
    thisMonth,
    yearToDate: profitOf(chart, byMonth),
    trend,
    topExpenses,
  };
}
