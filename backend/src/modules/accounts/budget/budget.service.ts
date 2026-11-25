import { runInTransaction } from '../../../db.js';
import { ApiError } from '../../../lib/errors.js';
import { changeRecord } from '../../../lib/records/recordWrites.js';
import { actorFields, type Actor } from '../../master/access/caller.js';
import { recordAudit } from '../../master/audit/audit.repository.js';
import { writeRecordHistory } from '../../master/records/recordHistory.service.js';
import { ACCOUNTS_MODULE_KEY } from '../accountsModule.js';
import { financialYearLabel, financialYearRange } from '../financialYear.js';
import { sumLinesForPeriod } from '../ledger/ledger.repository.js';
import { Bill } from '../models/bill.js';
import { Budget, type BudgetDoc, type BudgetLine } from '../models/budget.js';
import { LedgerAccount } from '../models/ledgerAccount.js';

const RESOURCE = 'budget';
const BASIS_POINTS_PER_WHOLE = 10_000;
/** Spending at or above this share of the budget is flagged before it goes over: 90%. */
const NEAR_LIMIT_BASIS_POINTS = 9_000;

export const BUDGET_STATUSES = ['under', 'near_limit', 'over', 'unbudgeted'] as const;
export type BudgetStatus = (typeof BUDGET_STATUSES)[number];

const budgetIdOf = (year: number) => `fy_${year}`;

const historyRef = (year: number) => ({ module: ACCOUNTS_MODULE_KEY, object: RESOURCE, recordId: budgetIdOf(year) });

const invalid = (path: string, message: string) => new ApiError(422, 'validation_failed', 'Some fields are invalid.', [{ path, message }]);

/** How much of the budget is used, and the status that goes with it. Nothing budgeted but something spent is unbudgeted. */
export function budgetStatusOf(budget: number, used: number): { usedBasisPoints?: number; status: BudgetStatus } {
  if (budget === 0) return { status: used > 0 ? 'unbudgeted' : 'under' };
  const usedBasisPoints = Math.round((used * BASIS_POINTS_PER_WHOLE) / budget);
  if (used > budget) return { usedBasisPoints, status: 'over' };
  return { usedBasisPoints, status: usedBasisPoints >= NEAR_LIMIT_BASIS_POINTS ? 'near_limit' : 'under' };
}

/** Bills not yet recorded (drafts and those waiting for approval), by the account each line is charged to. */
async function pendingBillsByAccount(from: string, to: string): Promise<Map<string, number>> {
  const rows = await Bill.aggregate<{ _id: string; amount: number }>([
    { $match: { status: { $in: ['draft', 'submitted'] }, billDate: { $gte: from, $lte: to } } },
    { $unwind: '$lines' },
    { $group: { _id: '$lines.accountId', amount: { $sum: '$lines.amount' } } },
  ]);
  return new Map(rows.map((row) => [row._id, row.amount]));
}

/**
 * A financial year's budget against what was spent, per expense account. Actual is read from the ledger (bills,
 * payroll, vouchers), and bills not yet approved are counted too, as pending, so a budget is warned about before
 * the spending is recorded. Accounts with spending but no budget are listed as unbudgeted.
 */
export async function getBudget(year: number) {
  const range = financialYearRange(year);
  const [budget, accounts] = await Promise.all([Budget.findById(budgetIdOf(year)).lean(), LedgerAccount.find({ type: 'expense' }).sort({ code: 1 }).lean()]);
  const accountIds = accounts.map((account) => account._id);
  const [ledgerTotals, pending] = await Promise.all([sumLinesForPeriod(accountIds, range.from, range.to), pendingBillsByAccount(range.from, range.to)]);
  const actualByAccount = new Map(ledgerTotals.map((totals) => [totals.accountId, totals.debit - totals.credit]));
  const budgetByAccount = new Map((budget?.lines ?? []).map((line) => [line.accountId, line.amount]));
  const lines = accounts.flatMap((account) => {
    const budgeted = budgetByAccount.get(account._id) ?? 0;
    const actual = actualByAccount.get(account._id) ?? 0;
    const pendingAmount = pending.get(account._id) ?? 0;
    if (budgeted === 0 && actual === 0 && pendingAmount === 0) return [];
    const used = actual + pendingAmount;
    return [{ accountId: account._id, code: account.code, name: account.name, budget: budgeted, actual, pending: pendingAmount, used, difference: budgeted - used, ...budgetStatusOf(budgeted, used) }];
  });
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  const totalBudget = sum(lines.map((line) => line.budget));
  const totalUsed = sum(lines.map((line) => line.used));
  return {
    year,
    yearLabel: financialYearLabel(year),
    from: range.from,
    to: range.to,
    lines,
    totals: { budget: totalBudget, actual: sum(lines.map((line) => line.actual)), pending: sum(lines.map((line) => line.pending)), used: totalUsed, difference: totalBudget - totalUsed, ...budgetStatusOf(totalBudget, totalUsed) },
    version: budget?.version,
    updatedAt: budget?.updatedAt,
  };
}

/** Sets a year's budget. The lines replace the old ones whole; an amount of 0 removes an account's budget. */
export async function setBudget(actor: Actor, year: number, request: { lines: BudgetLine[]; version?: number }) {
  const seen = new Set<string>();
  request.lines.forEach((line, index) => {
    if (seen.has(line.accountId)) throw invalid(`lines.${index}.accountId`, 'is listed twice');
    seen.add(line.accountId);
  });
  const expenseAccounts = new Set((await LedgerAccount.find({ _id: { $in: [...seen] }, type: 'expense' }).select('_id').lean()).map((account) => account._id));
  const notExpense = request.lines.findIndex((line) => !expenseAccounts.has(line.accountId));
  if (notExpense !== -1) throw invalid(`lines.${notExpense}.accountId`, 'must be an expense account');
  const lines = request.lines.filter((line) => line.amount > 0);
  const id = budgetIdOf(year);
  await runInTransaction(async (session) => {
    const existing = await Budget.findById(id).session(session).lean();
    let saved: BudgetDoc;
    if (existing) {
      saved = await changeRecord(Budget, id, { $set: { lines } }, { actorId: actor.user._id, expectedVersion: request.version ?? existing.version, session }, () => new ApiError(404, 'unknown_budget', 'No such budget.'));
    } else {
      const [created] = await Budget.create([{ _id: id, year, lines, createdBy: actor.user._id, updatedBy: actor.user._id }], { session });
      if (!created) throw new Error('Creating the budget returned nothing.');
      saved = created.toObject();
    }
    await writeRecordHistory(historyRef(year), { action: existing ? 'updated' : 'created', actor, ...(existing && { before: existing }), after: saved }, session);
    await recordAudit({ action: 'budget.updated', ...actorFields(actor), targetType: RESOURCE, targetId: id, targetName: `Budget ${financialYearLabel(year)}`, module: ACCOUNTS_MODULE_KEY }, session);
  });
  return getBudget(year);
}
