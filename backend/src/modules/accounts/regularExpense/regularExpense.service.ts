import { randomUUID } from 'node:crypto';
import { isDuplicateKeyError, runInTransaction } from '../../../db.js';
import { ApiError } from '../../../lib/errors.js';
import { changeRecord } from '../../../lib/records/recordWrites.js';
import { actorFields, type Actor } from '../../master/access/caller.js';
import { recordAudit } from '../../master/audit/audit.repository.js';
import { listRecordHistory, writeRecordHistory } from '../../master/records/recordHistory.service.js';
import type { PageRequest } from '../../../lib/query.js';
import { ACCOUNTS_MODULE_KEY } from '../accountsModule.js';
import { createBill, listBillsByIds, regularExpenseKeyOf } from '../bill/bill.service.js';
import { addMonths } from '../fixedAsset/depreciation.js';
import { financialYearLabel, financialYearOf, financialYearRange } from '../financialYear.js';
import { findLedgerAccountById } from '../ledgerAccount/ledgerAccount.repository.js';
import { todayAsEntryDate } from '../ledger/ledger.service.js';
import { Bill, type BillDoc } from '../models/bill.js';
import { RegularExpense, type RegularExpenseCategory, type RegularExpenseDoc, type RegularExpenseFrequency } from '../models/regularExpense.js';
import { monthLabel } from '../payroll/payroll.service.js';
import { findVendorById, vendorNotFound } from '../vendor/vendor.service.js';

const RESOURCE = 'regularExpense';
const MONTHS_IN_YEAR = 12;

export const regularExpenseNotFound = () => new ApiError(404, 'unknown_regular_expense', 'No such regular expense.');

const invalid = (path: string, message: string) => new ApiError(422, 'validation_failed', 'Some fields are invalid.', [{ path, message }]);

const historyRef = (expenseId: string) => ({ module: ACCOUNTS_MODULE_KEY, object: RESOURCE, recordId: expenseId });

const auditFields = (actor: Actor, expense: RegularExpenseDoc) => ({ ...actorFields(actor), targetType: RESOURCE, targetId: expense._id, targetName: expense.name, module: ACCOUNTS_MODULE_KEY });

export interface RegularExpenseDetails {
  name: string;
  category: RegularExpenseCategory;
  vendorId: string;
  accountId: string;
  frequency: RegularExpenseFrequency;
  amount: number;
  vatCode?: string;
  dayOfMonth: number;
  startMonth: string;
  endMonth?: string;
}

/** Whether the expense has a bill in this month: on or after its start, not after its end, and for a yearly one, in its month. */
export function isDueIn(expense: Pick<RegularExpenseDoc, 'frequency' | 'startMonth' | 'endMonth'>, month: string): boolean {
  if (month < expense.startMonth || (expense.endMonth && month > expense.endMonth)) return false;
  return expense.frequency === 'monthly' || month.slice(5, 7) === expense.startMonth.slice(5, 7);
}

/** The first period from `month` on that the expense is due, within a year's search; undefined after its end. */
export function nextDuePeriod(expense: Pick<RegularExpenseDoc, 'frequency' | 'startMonth' | 'endMonth'>, month: string): string | undefined {
  const from = month < expense.startMonth ? expense.startMonth : month;
  for (let step = 0; step < MONTHS_IN_YEAR; step += 1) {
    const candidate = addMonths(from, step);
    if (isDueIn(expense, candidate)) return candidate;
  }
  return undefined;
}

const periodDate = (period: string, dayOfMonth: number) => `${period}-${String(dayOfMonth).padStart(2, '0')}`;

/** The vendor and account checked as a bill will check them, so an expense that could never be billed is refused when saved. */
async function checkedVendorAndAccount(vendorId: string, accountId: string) {
  const [vendor, account] = await Promise.all([findVendorById(vendorId), findLedgerAccountById(accountId)]);
  if (!vendor) throw vendorNotFound();
  if (!vendor.isActive) throw invalid('vendorId', `${vendor.name} is inactive`);
  if (!account || !account.isActive) throw invalid('accountId', 'must be an active account in the chart of accounts');
  if (account.type !== 'expense') throw invalid('accountId', 'must be an expense account');
  return vendor;
}

/**
 * Each expense with the bill for its current period, if any, and the next period still to bill. "Next due" moves on
 * once the current period's bill is made; the bill's own status says whether it is approved and paid.
 */
async function viewsOf(expenses: RegularExpenseDoc[]) {
  const today = todayAsEntryDate().slice(0, 7);
  const bills = await Bill.find({ 'regularExpense.id': { $in: expenses.map((expense) => expense._id) }, status: { $ne: 'cancelled' } }).sort({ billDate: -1 }).lean();
  const billsByExpense = new Map<string, BillDoc[]>();
  for (const bill of bills) {
    const id = bill.regularExpense?.id;
    if (id) billsByExpense.set(id, [...(billsByExpense.get(id) ?? []), bill]);
  }
  return expenses.map((expense) => {
    const own = billsByExpense.get(expense._id) ?? [];
    const billed = new Set(own.map((bill) => bill.regularExpense?.period));
    let nextDue = nextDuePeriod(expense, today);
    // Periods already billed are skipped: the next due is the first one without a bill.
    while (nextDue && billed.has(nextDue)) nextDue = nextDuePeriod(expense, addMonths(nextDue, 1));
    const latest = own[0];
    return {
      id: expense._id,
      name: expense.name,
      category: expense.category,
      vendorId: expense.vendorId,
      vendorName: expense.vendorName,
      accountId: expense.accountId,
      frequency: expense.frequency,
      amount: expense.amount,
      vatCode: expense.vatCode,
      dayOfMonth: expense.dayOfMonth,
      startMonth: expense.startMonth,
      endMonth: expense.endMonth,
      isActive: expense.isActive,
      nextDue: expense.isActive && nextDue ? { period: nextDue, periodLabel: monthLabel(nextDue), date: periodDate(nextDue, expense.dayOfMonth) } : undefined,
      latestBill: latest ? { id: latest._id, number: latest.number, period: latest.regularExpense?.period, status: latest.status, netPayable: latest.netPayable } : undefined,
      version: expense.version,
    };
  });
}

async function requireExpense(expenseId: string): Promise<RegularExpenseDoc> {
  const expense = await RegularExpense.findById(expenseId).lean();
  if (!expense) throw regularExpenseNotFound();
  return expense;
}

export async function listRegularExpenses(filter: { category?: RegularExpenseCategory; isActive?: boolean } = {}) {
  const expenses = await RegularExpense.find({ ...(filter.category && { category: filter.category }), ...(filter.isActive !== undefined && { isActive: filter.isActive }) }).sort({ name: 1 }).lean();
  return { total: expenses.length, expenses: await viewsOf(expenses) };
}

export async function createRegularExpense(actor: Actor, details: RegularExpenseDetails) {
  if (details.endMonth && details.endMonth < details.startMonth) throw invalid('endMonth', 'must not be before the start month');
  const vendor = await checkedVendorAndAccount(details.vendorId, details.accountId);
  const expense = await runInTransaction(async (session) => {
    const [created] = await RegularExpense.create([{ _id: `re_${randomUUID()}`, ...details, vendorName: vendor.name, isActive: true, createdBy: actor.user._id, updatedBy: actor.user._id }], { session });
    if (!created) throw new Error('Creating the regular expense returned nothing.');
    const saved = created.toObject();
    await writeRecordHistory(historyRef(saved._id), { action: 'created', actor, after: saved }, session);
    await recordAudit({ action: 'regularExpense.created', ...auditFields(actor, saved) }, session);
    return saved;
  });
  const [view] = await viewsOf([expense]);
  return view;
}

/** Changes an expense. Bills already made keep what they were made with; the change applies from the next one. */
export async function updateRegularExpense(actor: Actor, expenseId: string, request: Partial<Omit<RegularExpenseDetails, 'endMonth' | 'vatCode'>> & { endMonth?: string | null; vatCode?: string | null; isActive?: boolean; version?: number }) {
  const { version, ...changes } = request;
  const existing = await requireExpense(expenseId);
  const after = { ...existing, ...changes };
  if (after.endMonth && after.endMonth < after.startMonth) throw invalid('endMonth', 'must not be before the start month');
  const vendor = changes.vendorId || changes.accountId ? await checkedVendorAndAccount(after.vendorId, after.accountId) : undefined;
  const $set: Record<string, unknown> = {};
  const $unset: Record<string, 1> = {};
  for (const [field, value] of Object.entries(changes)) {
    if (value === null) $unset[field] = 1;
    else if (value !== undefined) $set[field] = value;
  }
  if (vendor) $set.vendorName = vendor.name;
  const saved = await runInTransaction(async (session) => {
    const result = await changeRecord(RegularExpense, expenseId, { $set, ...(Object.keys($unset).length > 0 && { $unset }) }, { actorId: actor.user._id, expectedVersion: version ?? existing.version, session }, regularExpenseNotFound);
    await writeRecordHistory(historyRef(expenseId), { action: 'updated', actor, before: existing, after: result }, session);
    await recordAudit({ action: 'regularExpense.updated', ...auditFields(actor, result) }, session);
    return result;
  });
  const [view] = await viewsOf([saved]);
  return view;
}

export async function getRegularExpenseHistory(expenseId: string, page: PageRequest) {
  await requireExpense(expenseId);
  return listRecordHistory(historyRef(expenseId), page);
}

/**
 * Makes the draft bill for each active expense due in the month that doesn't have one yet (decision 4). Running it
 * again makes nothing new: a period's bill is found, and two people making them at once are kept apart by the
 * bill's unique key. Each bill goes through approval like any other.
 */
export async function makeRegularExpenseBills(actor: Actor, month: string) {
  const expenses = (await RegularExpense.find({ isActive: true }).sort({ name: 1 }).lean()).filter((expense) => isDueIn(expense, month));
  const existing = new Set((await Bill.find({ regularExpenseKey: { $in: expenses.map((expense) => regularExpenseKeyOf({ id: expense._id, period: month })) } }).select('regularExpenseKey').lean()).map((bill) => bill.regularExpenseKey));
  const made: Awaited<ReturnType<typeof createBill>>[] = [];
  const skipped: { id: string; name: string; reason: string }[] = [];
  for (const expense of expenses) {
    const origin = { id: expense._id, period: month };
    if (existing.has(regularExpenseKeyOf(origin))) {
      skipped.push({ id: expense._id, name: expense.name, reason: `already has a bill for ${monthLabel(month)}` });
      continue;
    }
    const date = periodDate(month, expense.dayOfMonth);
    try {
      made.push(await createBill(actor, {
        vendorId: expense.vendorId,
        billDate: date,
        dueDate: date,
        lines: [{ description: `${expense.name}, ${monthLabel(month)}`, accountId: expense.accountId, quantity: 1, unitPrice: expense.amount }],
        ...(expense.vatCode && { vatCode: expense.vatCode }),
      }, origin));
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        skipped.push({ id: expense._id, name: expense.name, reason: `already has a bill for ${monthLabel(month)}` });
        continue;
      }
      // A vendor made inactive, or a rate removed from Settings, stops only this expense's bill, with the reason.
      if (error instanceof ApiError && error.status === 422) {
        skipped.push({ id: expense._id, name: expense.name, reason: error.fields?.[0] ? `${error.fields[0].path} ${error.fields[0].message}` : error.message });
        continue;
      }
      throw error;
    }
  }
  return { month, monthLabel: monthLabel(month), made, skipped };
}

/**
 * Office rent for a financial year: the rent agreements (regular expenses in the rent category), and their bills with
 * what is paid and owed. Rent is charged when its bill is recorded, like any bill.
 */
export async function getOfficeRent(actor: Actor, year = financialYearOf(todayAsEntryDate())) {
  const range = financialYearRange(year);
  const { expenses } = await listRegularExpenses({ category: 'rent' });
  const rentBillIds = (await Bill.find({ 'regularExpense.id': { $in: expenses.map((expense) => expense.id) }, billDate: { $gte: range.from, $lte: range.to } }).select('_id').lean()).map((bill) => bill._id);
  const bills = await listBillsByIds(actor, rentBillIds);
  const recorded = bills.filter((bill) => bill.status === 'recorded');
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  return {
    year,
    yearLabel: financialYearLabel(year),
    agreements: expenses,
    bills,
    totals: {
      monthly: sum(expenses.filter((expense) => expense.isActive && expense.frequency === 'monthly').map((expense) => expense.amount)),
      charged: sum(recorded.map((bill) => bill.amount)),
      paid: sum(recorded.map((bill) => ('paid' in bill ? Number(bill.paid) : 0))),
      owed: sum(recorded.map((bill) => ('outstanding' in bill ? Number(bill.outstanding) : 0))),
    },
  };
}
