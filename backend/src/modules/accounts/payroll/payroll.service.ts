import { randomUUID } from 'node:crypto';
import { isDuplicateKeyError, runInTransaction } from '../../../db.js';
import { ApiError } from '../../../lib/errors.js';
import { monthBounds, type Month } from '../../../lib/period.js';
import type { PageRequest } from '../../../lib/query.js';
import { changeRecord } from '../../../lib/records/recordWrites.js';
import type { Actor } from '../../master/access/caller.js';
import { User } from '../../master/models/user.js';
import { redactRecord, type FieldRules } from '../../master/records/fieldSecurity.service.js';
import { findSalariesInEffect } from '../../hr/salary/salary.repository.js';
import { findUnpaidLedgerEntries, markLedgerEntryPaidByPayroll } from '../../tasks/incentive/incentive.repository.js';
import { assertNotOwnRecord, fieldRulesFor, findPeopleNames, invalidField, readRecordHistory, roundMoney, writeAccountsRecord, writeAccountsRecordIn } from '../accountsModule.js';
import { findRecordPage, insertRecord, requireRecord } from '../accountsFields.js';
import { requireActiveBankAccount } from '../bankAccount/bankAccount.service.js';
import { PayrollRun, type PayrollItem, type PayrollRunDoc, type PayrollRunStatus, type SettlementStatus } from '../models/payroll.js';

const RESOURCE = 'payrollRun';
/** Tasks incentives are in taka, so they're only added to pay in taka. */
const INCENTIVE_CURRENCY = 'BDT';

export const payrollRunNotFound = () => new ApiError(404, 'unknown_payroll_run', 'No such payroll run.');
const wrongStatus = (message: string) => new ApiError(409, 'invalid_status', message);

const monthLabel = ({ month, year }: Month) => `${year}-${String(month).padStart(2, '0')}`;
const label = (run: PayrollRunDoc) => `Payroll ${monthLabel(run)}`;
const monthOf = (run: PayrollRunDoc): Month => ({ month: run.month, year: run.year });

const totals = (items: PayrollItem[]) => {
  const byCurrency = new Map<string, number>();
  for (const item of items) byCurrency.set(item.currency, roundMoney((byCurrency.get(item.currency) ?? 0) + item.netAmount));
  return [...byCurrency].map(([currency, netAmount]) => ({ currency, netAmount }));
};

function toView(run: PayrollRunDoc, rules: FieldRules, names: Map<string, string>, withItems: boolean) {
  return redactRecord(
    {
      id: run._id,
      month: run.month,
      year: run.year,
      status: run.status,
      bankAccountId: run.bankAccountId,
      notes: run.notes,
      decidedBy: run.decidedBy,
      decidedAt: run.decidedAt,
      returnReason: run.returnReason,
      employeeCount: run.items.length,
      paidCount: run.items.filter((item) => item.settlementStatus === 'paid').length,
      totals: totals(run.items),
      ...(withItems && {
        items: run.items.map(({ _id, ...item }) => ({ id: _id, ...item, name: names.get(item.userId) })),
      }),
      version: run.version,
      createdBy: run.createdBy,
      createdAt: run.createdAt,
      updatedBy: run.updatedBy,
      updatedAt: run.updatedAt,
    },
    rules,
  );
}

async function toViews(actor: Actor, runs: PayrollRunDoc[], withItems = false) {
  const [rules, names] = await Promise.all([fieldRulesFor(actor, RESOURCE), withItems ? findPeopleNames(runs.flatMap((run) => run.items.map((item) => item.userId))) : new Map<string, string>()]);
  return runs.map((run) => toView(run, rules, names, withItems));
}

export async function listPayrollRuns(actor: Actor, query: PageRequest & { year?: number; status?: PayrollRunStatus }) {
  const { year, status, ...page } = query;
  const { records, total } = await findRecordPage(PayrollRun, { ...(year && { year }), ...(status && { status }) }, page, { year: -1, month: -1 });
  return { total, payrollRuns: await toViews(actor, records) };
}

export async function getPayrollRun(actor: Actor, runId: string) {
  const [view] = await toViews(actor, [await requireRecord(PayrollRun, runId, payrollRunNotFound)], true);
  return view!;
}

/**
 * Makes a month's run from HR salaries: each person's approved salary in effect at the month's end, plus their unpaid
 * monthly incentive for the month from Tasks. Without userIds, everyone active with an approved salary is included.
 */
export async function createPayrollRun(actor: Actor, request: Month & { userIds?: string[]; bankAccountId?: string; notes?: string }) {
  const account = request.bankAccountId ? await requireActiveBankAccount(request.bankAccountId) : undefined;
  const lastDay = new Date(monthBounds(request).before.getTime() - 1);
  const requested = request.userIds ? [...new Set(request.userIds)] : null;
  const activeIds: string[] = await User.find({ status: 'active', ...(requested && { _id: { $in: requested } }) }).distinct('_id');
  if (requested) {
    const unknown = requested.filter((userId) => !activeIds.includes(userId));
    if (unknown.length > 0) throw invalidField('userIds', `${unknown.join(', ')} ${unknown.length === 1 ? 'is not an active person' : 'are not active people'}`);
  }

  const salaries = await findSalariesInEffect(activeIds, lastDay);
  if (requested) {
    const unpaid = requested.filter((userId) => !salaries.has(userId));
    if (unpaid.length > 0) throw invalidField('userIds', `${unpaid.join(', ')} ${unpaid.length === 1 ? 'has' : 'have'} no approved salary in effect for this month`);
  }
  if (salaries.size === 0) throw new ApiError(422, 'nothing_to_pay', 'Nobody has an approved salary in effect for this month.');
  const incentives = await findUnpaidLedgerEntries([...salaries.keys()], request);

  const items: PayrollItem[] = [...salaries.values()].map((salary) => {
    const incentive = salary.currency === INCENTIVE_CURRENCY ? (incentives.get(salary.employeeId)?.totalPayout ?? 0) : 0;
    const gross = roundMoney(salary.amount + incentive);
    return {
      _id: `pi_${randomUUID()}`,
      userId: salary.employeeId,
      salaryId: salary._id,
      currency: salary.currency,
      salaryAmount: salary.amount,
      incentiveAmount: incentive,
      deductions: 0,
      grossAmount: gross,
      netAmount: gross,
      ...(account && salary.currency === account.currency && { bankAccountId: account._id }),
      settlementStatus: 'unpaid',
    };
  });

  try {
    const created = await writeAccountsRecord(actor, {
      resource: RESOURCE,
      auditAction: 'payrollRun.created',
      write: (session) =>
        insertRecord<PayrollRunDoc>(PayrollRun, { _id: `pr_${randomUUID()}`, month: request.month, year: request.year, activeMonth: monthLabel(request), bankAccountId: request.bankAccountId, notes: request.notes, items }, actor.user._id, session),
      label,
    });
    return getPayrollRun(actor, created._id);
  } catch (error) {
    if (isDuplicateKeyError(error)) throw new ApiError(409, 'run_exists', `There is already a payroll run for ${monthLabel(request)}.`);
    throw error;
  }
}

async function changeRun(actor: Actor, runId: string, change: { auditAction: string; allowedFrom: readonly PayrollRunStatus[]; refusal: string; check?: (run: PayrollRunDoc) => void; set: Record<string, unknown>; version?: number }) {
  const existing = await requireRecord(PayrollRun, runId, payrollRunNotFound);
  if (!change.allowedFrom.includes(existing.status)) throw wrongStatus(change.refusal);
  change.check?.(existing);
  await writeAccountsRecord(actor, {
    resource: RESOURCE,
    auditAction: change.auditAction,
    before: existing,
    write: (session) => changeRecord(PayrollRun, runId, { $set: change.set }, { actorId: actor.user._id, expectedVersion: change.version ?? existing.version, session }, payrollRunNotFound),
    label,
  });
  return getPayrollRun(actor, runId);
}

/** Changes a draft's notes, bank account, or one person's deductions, which lower their net pay. */
export async function updatePayrollRun(actor: Actor, runId: string, changes: { notes?: string; bankAccountId?: string; deductions?: { itemId: string; amount: number }[]; version?: number }) {
  const existing = await requireRecord(PayrollRun, runId, payrollRunNotFound);
  const account = changes.bankAccountId ? await requireActiveBankAccount(changes.bankAccountId) : undefined;
  const deductions = new Map((changes.deductions ?? []).map((entry) => [entry.itemId, entry.amount]));
  for (const itemId of deductions.keys()) if (!existing.items.some((item) => item._id === itemId)) throw invalidField('deductions', `${itemId} is not an item of this run`);
  const items = existing.items.map((item) => {
    const deduction = deductions.get(item._id) ?? item.deductions;
    if (deduction > item.grossAmount) throw invalidField('deductions', `${item._id} can't have more deducted than its gross pay`);
    return { ...item, deductions: deduction, netAmount: roundMoney(item.grossAmount - deduction), ...(account && item.currency === account.currency && { bankAccountId: account._id }) };
  });
  return changeRun(actor, runId, {
    auditAction: 'payrollRun.updated',
    allowedFrom: ['draft'],
    refusal: 'Only a draft payroll run can change.',
    set: { items, ...(changes.notes !== undefined && { notes: changes.notes }), ...(changes.bankAccountId && { bankAccountId: changes.bankAccountId }) },
    version: changes.version,
  });
}

export const submitPayrollRun = (actor: Actor, runId: string) =>
  changeRun(actor, runId, { auditAction: 'payrollRun.submitted', allowedFrom: ['draft'], refusal: 'Only a draft payroll run can be sent for approval.', set: { status: 'pending_approval' } });

export const approvePayrollRun = (actor: Actor, runId: string) =>
  changeRun(actor, runId, {
    auditAction: 'payrollRun.approved',
    allowedFrom: ['pending_approval'],
    refusal: 'Only a payroll run waiting for approval can be approved.',
    check: (run) => assertNotOwnRecord(actor, run.createdBy, 'payroll run'),
    set: { status: 'approved', decidedBy: actor.user._id, decidedAt: new Date() },
  });

/** Sends a run back to draft with the reason, so it can be corrected and submitted again. */
export const returnPayrollRun = (actor: Actor, runId: string, reason: string) =>
  changeRun(actor, runId, {
    auditAction: 'payrollRun.returned',
    allowedFrom: ['pending_approval'],
    refusal: 'Only a payroll run waiting for approval can be sent back.',
    check: (run) => assertNotOwnRecord(actor, run.createdBy, 'payroll run'),
    set: { status: 'draft', returnReason: reason, decidedBy: actor.user._id, decidedAt: new Date() },
  });

export async function deletePayrollRun(actor: Actor, runId: string): Promise<void> {
  const existing = await requireRecord(PayrollRun, runId, payrollRunNotFound);
  if (existing.status !== 'draft') throw wrongStatus('Only a draft payroll run can be deleted.');
  await writeAccountsRecord(actor, {
    resource: RESOURCE,
    auditAction: 'payrollRun.deleted',
    before: existing,
    historyAction: 'deleted',
    // Freeing the month lets it be run again.
    write: (session) =>
      changeRecord(PayrollRun, runId, { $set: { deletedAt: new Date(), deletedBy: actor.user._id }, $unset: { activeMonth: 1 } }, { actorId: actor.user._id, expectedVersion: existing.version, session }, payrollRunNotFound),
    label,
  });
}

/**
 * Records how one person's pay went: paid, failed or returned, or back to unpaid. Only once the run is approved.
 * Paying it also marks the person's Tasks incentive for the month paid, since the run included it. When everyone's pay
 * is settled the run completes.
 */
export async function settlePayrollItem(actor: Actor, runId: string, itemId: string, request: { settlementStatus: SettlementStatus; reference?: string; notes?: string; version?: number }) {
  const existing = await requireRecord(PayrollRun, runId, payrollRunNotFound);
  if (existing.status !== 'approved' && existing.status !== 'completed') throw wrongStatus("Only an approved payroll run's pay can be settled.");
  const item = existing.items.find((candidate) => candidate._id === itemId);
  if (!item) throw new ApiError(404, 'unknown_payroll_item', 'No such item in this payroll run.');

  const marksIncentive = request.settlementStatus === 'paid' && item.incentiveAmount > 0 && !item.incentiveMarkedPaid;
  const items = existing.items.map((candidate) =>
    candidate._id === itemId
      ? {
          ...candidate,
          settlementStatus: request.settlementStatus,
          settledAt: request.settlementStatus === 'unpaid' ? undefined : new Date(),
          reference: request.reference ?? candidate.reference,
          notes: request.notes ?? candidate.notes,
          ...(marksIncentive && { incentiveMarkedPaid: true }),
        }
      : candidate,
  );
  const status: PayrollRunStatus = items.every((candidate) => candidate.settlementStatus !== 'unpaid') ? 'completed' : 'approved';

  await runInTransaction(async (session) => {
    // The run is written first, so a stale or second settlement is refused as a version conflict before Tasks is read.
    await writeAccountsRecordIn(
      actor,
      {
        resource: RESOURCE,
        auditAction: `payrollRun.item_${request.settlementStatus}`,
        before: existing,
        write: (writeSession) => changeRecord(PayrollRun, runId, { $set: { items, status } }, { actorId: actor.user._id, expectedVersion: request.version ?? existing.version, session: writeSession }, payrollRunNotFound),
        label,
      },
      session,
    );
    // The incentive is in this pay, so if Tasks paid it since the run was made, paying this would pay it twice.
    if (marksIncentive && !(await markLedgerEntryPaidByPayroll(item.userId, monthOf(existing), actor.user._id, session))) {
      throw new ApiError(
        409,
        'incentive_already_paid',
        "This person's Tasks incentive for the month was paid after the run was made, so this pay would pay it twice. Mark it failed and pay the salary on its own.",
      );
    }
  });
  return getPayrollRun(actor, runId);
}

export async function getPayrollRunHistory(actor: Actor, runId: string, page: PageRequest) {
  await requireRecord(PayrollRun, runId, payrollRunNotFound);
  return readRecordHistory(actor, RESOURCE, runId, page);
}
