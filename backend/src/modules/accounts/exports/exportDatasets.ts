import type { Actor } from '../../master/access/caller.js';
import type { PageRequest } from '../../../lib/query.js';
import { listBills } from '../bill/bill.service.js';
import { getBudget } from '../budget/budget.service.js';
import { listEmployeeLoans } from '../employeeLoan/employeeLoan.service.js';
import { listFixedAssets } from '../fixedAsset/fixedAsset.service.js';
import { getTrialBalanceView } from '../generalLedger/generalLedger.service.js';
import { listInventoryItems } from '../inventory/inventory.service.js';
import { listInvoices } from '../invoice/invoice.service.js';
import { listJournalVouchers } from '../journalVoucher/journalVoucher.service.js';
import { listLedgerAccounts } from '../ledgerAccount/ledgerAccount.service.js';
import { listPayrollRuns } from '../payroll/payroll.service.js';
import { listRegularExpenses } from '../regularExpense/regularExpense.service.js';
import { getBalanceSheet, getCashFlow, getProfitAndLoss, type ReportSection } from '../reports/reports.service.js';
import { listStaffPayouts } from '../staffPayout/staffPayout.service.js';
import { getTaxFilings } from '../taxFiling/taxFiling.service.js';
import { listVendors } from '../vendor/vendor.service.js';
import { taka, type CellValue } from './csv.js';

/*
 * Every list and report the Export center offers. Each one loads its rows through the same service its screen uses,
 * so the rows are already limited to what the person may read, and names the permission that screen needs. A column
 * that shows a protected field names it, and is left out of the file, header and all, when the field is hidden.
 */

/** What a dataset needs to know besides who is asking: a period, one date, a financial year, or nothing. */
export type ExportPeriod = 'range' | 'date' | 'year' | 'none';

export interface ExportQuery {
  from: string;
  to: string;
  year: number;
}

export interface ExportColumn<Row> {
  header: string;
  value: (row: Row) => CellValue;
  /** The protected field this column shows, on the dataset's resource. */
  field?: string;
}

export interface ExportDataset<Row = unknown> {
  key: string;
  label: string;
  group: 'Reports' | 'Books' | 'Receivables' | 'Payables' | 'People money' | 'Tax and assets';
  permission: string;
  /** The manifest resource whose field security decides which columns are shown. */
  resource: string;
  period: ExportPeriod;
  /** A protected field every row is made of, such as each person's salary: without it there is nothing to export. */
  requiresField?: string;
  load: (actor: Actor, query: ExportQuery) => Promise<Row[]>;
  columns: ExportColumn<Row>[];
}

/** Keeps each dataset's columns checked against its own rows, then lets the list hold them together. */
const dataset = <Row>(definition: ExportDataset<Row>) => definition as unknown as ExportDataset;

const EXPORT_PAGE_SIZE = 100;
/** A safety stop: a million rows is far beyond any list here, and a bug must not loop for ever. */
const MAX_PAGES = 10_000;

/** Every row of a paged list, a page at a time, as its screen would read them all. */
async function everyPage<Item>(loadPage: (page: PageRequest) => Promise<{ total: number; items: Item[] }>): Promise<Item[]> {
  const rows: Item[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const { total, items } = await loadPage({ page, pageSize: EXPORT_PAGE_SIZE });
    rows.push(...items);
    if (items.length === 0 || rows.length >= total) break;
  }
  return rows;
}

const personName = (person?: { name?: string }) => person?.name;

/** A report's sections as rows: each account, then the section's total. */
interface StatementRow {
  section: string;
  code?: string;
  name: string;
  amount: number;
}

function statementRows(sections: ReportSection[]): StatementRow[] {
  return sections.flatMap((section) => [
    ...section.rows.map((row) => ({ section: section.label, code: row.code, name: row.name, amount: row.amount })),
    { section: section.label, name: `Total ${section.label.toLowerCase()}`, amount: section.total },
  ]);
}

const statementColumns: ExportColumn<StatementRow>[] = [
  { header: 'Section', value: (row) => row.section },
  { header: 'Code', value: (row) => row.code },
  { header: 'Account', value: (row) => row.name },
  { header: 'Amount (Tk)', value: (row) => taka(row.amount) },
];

const REPORTS = [
  dataset<StatementRow>({
    key: 'profit-and-loss',
    label: 'Profit and loss',
    group: 'Reports',
    permission: 'ledgerAccount.read',
    resource: 'ledgerAccount',
    period: 'range',
    load: async (_actor, { from, to }) => {
      const report = await getProfitAndLoss(from, to);
      return [...statementRows([report.income, report.expenses]), { section: '', name: 'Net profit', amount: report.netProfit }];
    },
    columns: statementColumns,
  }),
  dataset<StatementRow>({
    key: 'balance-sheet',
    label: 'Balance sheet',
    group: 'Reports',
    permission: 'ledgerAccount.read',
    resource: 'ledgerAccount',
    period: 'date',
    load: async (_actor, { to }) => {
      const report = await getBalanceSheet(to);
      const equity = { ...report.equity, rows: [...report.equity.rows, ...report.equity.profitRows.map((row) => ({ accountId: row.key, code: '', name: row.label, amount: row.amount }))] };
      return [...statementRows([report.assets, report.liabilities, equity]), { section: '', name: 'Total liabilities and equity', amount: report.totalLiabilitiesAndEquity }];
    },
    columns: statementColumns,
  }),
  dataset<StatementRow>({
    key: 'cash-flow',
    label: 'Cash flow',
    group: 'Reports',
    permission: 'ledgerAccount.read',
    resource: 'ledgerAccount',
    period: 'range',
    load: async (_actor, { from, to }) => {
      const report = await getCashFlow(from, to);
      return [
        { section: '', name: 'Cash and bank at the start', amount: report.opening },
        ...statementRows(report.sections),
        { section: '', name: 'Net change', amount: report.netChange },
        { section: '', name: 'Cash and bank at the end', amount: report.closing },
      ];
    },
    columns: statementColumns,
  }),
  dataset({
    key: 'trial-balance',
    label: 'Trial balance',
    group: 'Reports',
    permission: 'ledgerAccount.read',
    resource: 'ledgerAccount',
    period: 'date',
    load: async (_actor, { to }) => (await getTrialBalanceView(to)).rows,
    columns: [
      { header: 'Code', value: (row) => row.code },
      { header: 'Account', value: (row) => row.name },
      { header: 'Type', value: (row) => row.type },
      { header: 'Debit (Tk)', value: (row) => taka(row.debit) },
      { header: 'Credit (Tk)', value: (row) => taka(row.credit) },
      { header: 'Balance, debit side (Tk)', value: (row) => taka(row.balance) },
    ],
  }),
];

const BOOKS = [
  dataset({
    key: 'chart-of-accounts',
    label: 'Chart of accounts',
    group: 'Books',
    permission: 'ledgerAccount.read',
    resource: 'ledgerAccount',
    period: 'none',
    load: (actor) => everyPage(async (page) => {
      const { total, accounts } = await listLedgerAccounts(actor, page);
      return { total, items: accounts };
    }),
    columns: [
      { header: 'Code', value: (row) => row.code },
      { header: 'Account', value: (row) => row.name },
      { header: 'Type', value: (row) => row.type },
      { header: 'Cash or bank', value: (row) => row.cashOrBank },
      { header: 'Bank', value: (row) => row.bankName },
      { header: 'Bank account number', value: (row) => row.bankAccountNumber, field: 'bankAccountNumber' },
      { header: 'Balance (Tk)', value: (row) => taka(row.balance) },
      { header: 'Active', value: (row) => row.isActive },
    ],
  }),
  dataset({
    key: 'vouchers',
    label: 'Vouchers',
    group: 'Books',
    permission: 'journalVoucher.read',
    resource: 'journalVoucher',
    period: 'none',
    load: (actor) => everyPage(async (page) => {
      const { total, vouchers } = await listJournalVouchers(actor, page);
      return { total, items: vouchers };
    }),
    columns: [
      { header: 'Number', value: (row) => row.number },
      { header: 'Type', value: (row) => row.voucherType },
      { header: 'Date', value: (row) => row.voucherDate },
      { header: 'Memo', value: (row) => row.memo },
      { header: 'Party', value: (row) => row.party },
      { header: 'Reference', value: (row) => row.reference },
      { header: 'Total (Tk)', value: (row) => taka(row.total) },
      { header: 'Status', value: (row) => row.status },
      { header: 'Made by', value: (row) => personName(row.createdBy) },
      { header: 'Approved by', value: (row) => personName(row.approvedBy) },
    ],
  }),
];

const RECEIVABLES_AND_PAYABLES = [
  dataset({
    key: 'invoices',
    label: 'Invoices',
    group: 'Receivables',
    permission: 'invoice.read',
    resource: 'invoice',
    period: 'none',
    load: (actor) => everyPage(async (page) => {
      const { total, invoices } = await listInvoices(actor, page);
      return { total, items: invoices };
    }),
    columns: [
      { header: 'Number', value: (row) => row.number },
      { header: 'Client', value: (row) => row.clientName },
      { header: 'Issue date', value: (row) => row.issueDate },
      { header: 'Due date', value: (row) => row.dueDate },
      { header: 'Currency', value: (row) => row.currency },
      { header: 'Total, in its currency', value: (row) => taka(row.total) },
      { header: 'Total (Tk)', value: (row) => (row.totalInTaka === undefined ? undefined : taka(row.totalInTaka)) },
      { header: 'Status', value: (row) => row.status },
      { header: 'Payment', value: (row) => row.paymentStatus },
      { header: 'Outstanding, in its currency', value: (row) => (row.outstanding === undefined ? undefined : taka(row.outstanding)) },
    ],
  }),
  dataset({
    key: 'vendors',
    label: 'Vendors',
    group: 'Payables',
    permission: 'vendor.read',
    resource: 'vendor',
    period: 'none',
    load: (actor) => everyPage(async (page) => {
      const { total, vendors } = await listVendors(actor, page);
      return { total, items: vendors };
    }),
    columns: [
      { header: 'Name', value: (row) => row.name },
      { header: 'Category', value: (row) => row.category },
      { header: 'TDS (%)', value: (row) => row.tdsBasisPoints / 100 },
      { header: 'Email', value: (row) => row.contactEmail },
      { header: 'Phone', value: (row) => row.contactPhone },
      { header: 'Active', value: (row) => row.isActive },
    ],
  }),
  dataset({
    key: 'bills',
    label: 'Bills',
    group: 'Payables',
    permission: 'bill.read',
    resource: 'bill',
    period: 'none',
    load: (actor) => everyPage(async (page) => {
      const { total, bills } = await listBills(actor, page);
      return { total, items: bills };
    }),
    columns: [
      { header: 'Number', value: (row) => row.number },
      { header: 'Vendor', value: (row) => row.vendorName },
      { header: 'Vendor reference', value: (row) => row.vendorReference },
      { header: 'Bill date', value: (row) => row.billDate },
      { header: 'Due date', value: (row) => row.dueDate },
      { header: 'Amount before tax (Tk)', value: (row) => taka(row.amount) },
      { header: 'VAT (Tk)', value: (row) => taka(row.vat ?? 0) },
      { header: 'TDS (Tk)', value: (row) => taka(row.tds) },
      { header: 'Net to pay (Tk)', value: (row) => taka(row.netPayable) },
      { header: 'Status', value: (row) => row.status },
      { header: 'Payment', value: (row) => row.paymentStatus },
      { header: 'Outstanding (Tk)', value: (row) => (row.outstanding === undefined ? undefined : taka(row.outstanding)) },
    ],
  }),
  dataset({
    key: 'regular-expenses',
    label: 'Regular expenses',
    group: 'Payables',
    permission: 'regularExpense.read',
    resource: 'regularExpense',
    period: 'none',
    load: async () => (await listRegularExpenses()).expenses,
    columns: [
      { header: 'Name', value: (row) => row.name },
      { header: 'Category', value: (row) => row.category },
      { header: 'Vendor', value: (row) => row.vendorName },
      { header: 'How often', value: (row) => row.frequency },
      { header: 'Amount per period (Tk)', value: (row) => taka(row.amount) },
      { header: 'VAT', value: (row) => row.vatCode },
      { header: 'Day of the month', value: (row) => row.dayOfMonth },
      { header: 'First month', value: (row) => row.startMonth },
      { header: 'Last month', value: (row) => row.endMonth },
      { header: 'Next due', value: (row) => row.nextDue?.date },
      { header: 'Active', value: (row) => row.isActive },
    ],
  }),
];

/** One person's line on a payroll run, with the run it belongs to. */
type PayrollRunRow = Awaited<ReturnType<typeof listPayrollRuns>>['runs'][number];
type SalaryRow = { run: PayrollRunRow; line: NonNullable<PayrollRunRow['lines']>[number] };

const allPayrollRuns = (actor: Actor) => everyPage(async (page) => {
  const { total, runs } = await listPayrollRuns(actor, page);
  return { total, items: runs };
});

const PEOPLE_MONEY = [
  dataset({
    key: 'payroll-runs',
    label: 'Payroll runs',
    group: 'People money',
    permission: 'payrollRun.read',
    resource: 'payrollRun',
    period: 'none',
    load: allPayrollRuns,
    columns: [
      { header: 'Number', value: (row) => row.number },
      { header: 'Month', value: (row) => row.month },
      { header: 'Pay date', value: (row) => row.payDate },
      { header: 'People', value: (row) => row.headcount },
      { header: 'Gross (Tk)', value: (row) => taka(row.total) },
      { header: 'Net paid (Tk)', value: (row) => ('netTotal' in row && typeof row.netTotal === 'number' ? taka(row.netTotal) : undefined) },
      { header: 'Status', value: (row) => row.status },
      { header: 'Payment', value: (row) => row.paymentStatus },
    ],
  }),
  dataset<SalaryRow>({
    key: 'salaries',
    label: 'Salary per person',
    group: 'People money',
    permission: 'payrollRun.read',
    resource: 'payrollRun',
    period: 'none',
    requiresField: 'lines',
    load: async (actor) => (await allPayrollRuns(actor)).flatMap((run) => (run.lines ?? []).map((line) => ({ run, line }))),
    columns: [
      { header: 'Payroll', value: ({ run }) => run.number },
      { header: 'Month', value: ({ run }) => run.month },
      { header: 'Employee code', value: ({ line }) => line.employeeCode },
      { header: 'Name', value: ({ line }) => line.name },
      { header: 'Department', value: ({ line }) => line.department },
      { header: 'Gross (Tk)', value: ({ line }) => taka(line.gross) },
      { header: 'Unpaid leave (Tk)', value: ({ line }) => taka(line.leaveDeduction ?? 0) },
      { header: 'Provident fund (Tk)', value: ({ line }) => taka(line.providentFund ?? 0) },
      { header: 'Loan repaid (Tk)', value: ({ line }) => taka((line.loanRepayments ?? []).reduce((sum, repayment) => sum + repayment.amount, 0)) },
      { header: 'Net (Tk)', value: ({ line }) => taka(line.net ?? line.gross) },
    ],
  }),
  dataset({
    key: 'staff-payouts',
    label: 'Bonus, incentive and commission',
    group: 'People money',
    permission: 'staffPayout.read',
    resource: 'staffPayout',
    period: 'none',
    load: () => everyPage(async (page) => {
      const { total, payouts } = await listStaffPayouts(page);
      return { total, items: payouts };
    }),
    columns: [
      { header: 'Number', value: (row) => row.number },
      { header: 'Kind', value: (row) => row.kind },
      { header: 'Title', value: (row) => row.title },
      { header: 'Pay date', value: (row) => row.payDate },
      { header: 'People', value: (row) => row.headcount },
      { header: 'Total (Tk)', value: (row) => taka(row.total) },
      { header: 'Status', value: (row) => row.status },
    ],
  }),
  dataset({
    key: 'loans',
    label: 'Loans and advances',
    group: 'People money',
    permission: 'employeeLoan.read',
    resource: 'employeeLoan',
    period: 'none',
    load: () => everyPage(async (page) => {
      const { total, loans } = await listEmployeeLoans(page);
      return { total, items: loans };
    }),
    columns: [
      { header: 'Number', value: (row) => row.number },
      { header: 'Employee', value: (row) => row.employeeName },
      { header: 'Kind', value: (row) => row.kind },
      { header: 'Purpose', value: (row) => row.purpose },
      { header: 'Issue date', value: (row) => row.issueDate },
      { header: 'Amount (Tk)', value: (row) => taka(row.amount) },
      { header: 'Monthly installment (Tk)', value: (row) => taka(row.monthlyInstallment) },
      { header: 'Repaid (Tk)', value: (row) => taka(row.repaid) },
      { header: 'Outstanding (Tk)', value: (row) => taka(row.outstanding) },
      { header: 'Status', value: (row) => row.status },
    ],
  }),
];

const TAX_AND_ASSETS = [
  dataset({
    key: 'tax-filings',
    label: 'Tax and VAT',
    group: 'Tax and assets',
    permission: 'taxFiling.read',
    resource: 'taxFiling',
    period: 'year',
    load: async (_actor, { year }) => (await getTaxFilings(year)).filings,
    columns: [
      { header: 'Tax', value: (row) => (row.type === 'vendor_tds' ? 'TDS on vendor bills' : 'VAT on purchases') },
      { header: 'Month', value: (row) => row.month },
      { header: 'Base (Tk)', value: (row) => taka(row.base) },
      { header: 'Amount (Tk)', value: (row) => taka(row.amount) },
      { header: 'Due date', value: (row) => row.dueDate },
      { header: 'Payment', value: (row) => ('paymentStatus' in row ? row.paymentStatus : undefined) },
    ],
  }),
  dataset({
    key: 'budget',
    label: 'Budget against actual',
    group: 'Tax and assets',
    permission: 'budget.read',
    resource: 'budget',
    period: 'year',
    load: async (_actor, { year }) => (await getBudget(year)).lines,
    columns: [
      { header: 'Code', value: (row) => row.code },
      { header: 'Expense account', value: (row) => row.name },
      { header: 'Budget (Tk)', value: (row) => taka(row.budget) },
      { header: 'Spent (Tk)', value: (row) => taka(row.actual) },
      { header: 'Waiting (Tk)', value: (row) => taka(row.pending) },
      { header: 'Left (Tk)', value: (row) => taka(row.difference) },
      { header: 'Status', value: (row) => row.status },
    ],
  }),
  dataset({
    key: 'fixed-assets',
    label: 'Fixed assets',
    group: 'Tax and assets',
    permission: 'fixedAsset.read',
    resource: 'fixedAsset',
    period: 'none',
    load: (actor) => everyPage(async (page) => {
      const { total, assets } = await listFixedAssets(actor, page);
      return { total, items: assets };
    }),
    columns: [
      { header: 'Number', value: (row) => row.number },
      { header: 'Name', value: (row) => row.name },
      { header: 'Asset tag', value: (row) => row.assetTag },
      { header: 'Category', value: (row) => row.category },
      { header: 'Purchase date', value: (row) => row.purchaseDate },
      { header: 'Cost (Tk)', value: (row) => taka(row.cost) },
      { header: 'Depreciation to date (Tk)', value: (row) => taka(row.accumulatedDepreciation) },
      { header: 'Book value (Tk)', value: (row) => taka(row.bookValue) },
      { header: 'Active', value: (row) => row.isActive },
    ],
  }),
  dataset({
    key: 'inventory',
    label: 'Inventory',
    group: 'Tax and assets',
    permission: 'inventoryItem.read',
    resource: 'inventoryItem',
    period: 'none',
    load: (actor) => everyPage(async (page) => {
      const { total, items } = await listInventoryItems(actor, page);
      return { total, items };
    }),
    columns: [
      { header: 'Name', value: (row) => row.name },
      { header: 'Asset tag', value: (row) => row.assetTag },
      { header: 'Category', value: (row) => row.category },
      { header: 'Unit', value: (row) => row.unit },
      { header: 'On hand', value: (row) => row.onHand },
      { header: 'Reorder level', value: (row) => row.reorderLevel },
      { header: 'Active', value: (row) => row.isActive },
    ],
  }),
];

export const EXPORT_DATASETS: ExportDataset[] = [...REPORTS, ...BOOKS, ...RECEIVABLES_AND_PAYABLES, ...PEOPLE_MONEY, ...TAX_AND_ASSETS];

/** Every permission some dataset needs: the route lets in anyone holding one, and the service checks the dataset's own. */
export const EXPORT_PERMISSIONS = [...new Set(EXPORT_DATASETS.map((each) => each.permission))];
