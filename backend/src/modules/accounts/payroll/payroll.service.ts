import { randomUUID } from 'node:crypto';
import type { ClientSession, UpdateQuery } from 'mongoose';
import { isDuplicateKeyError, runInTransaction } from '../../../db.js';
import { ApiError } from '../../../lib/errors.js';
import { pageOffset, type PageRequest } from '../../../lib/query.js';
import { changeRecord } from '../../../lib/records/recordWrites.js';
import { actorFields, type Actor } from '../../master/access/caller.js';
import { recordAudit } from '../../master/audit/audit.repository.js';
import { assertMayWriteFields, readFieldRules, redactHistory, redactRecord, type FieldRules } from '../../master/records/fieldSecurity.service.js';
import { listRecordHistory, writeRecordHistory } from '../../master/records/recordHistory.service.js';
import { findUsersByIds } from '../../master/users/users.repository.js';
import { ACCOUNTS_MODULE_KEY } from '../accountsModule.js';
import { assertMayDecide, mayDecide } from '../approvals/approvalRules.js';
import { takeNextDocumentNumber } from '../documentNumbers.js';
import { assertWithinOpenAmount, paymentStateOf, wrongDocumentStatus } from '../documents/documentState.js';
import { findVouchersLinkedTo, sumSettledAmounts } from '../journalVoucher/journalVoucher.repository.js';
import { createLinkedVoucher } from '../journalVoucher/journalVoucher.service.js';
import { postEntry, reverseEntry, type NewLedgerLine } from '../ledger/ledger.service.js';
import { AccountsEmployee, type AccountsEmployeeDoc } from '../models/accountsEmployee.js';
import { PayrollRun, type PayrollLine, type PayrollRunDoc, type PayrollRunStatus } from '../models/payrollRun.js';
import { POSTING_ACCOUNTS } from '../postingAccounts.js';

const PAYROLL_RESOURCE = 'payrollRun';
const APPROVE_PERMISSION = 'payrollRun.approve';

const STATUS_LABELS: Record<PayrollRunStatus, string> = { draft: 'a draft', submitted: 'waiting for approval', recorded: 'recorded', cancelled: 'cancelled' };

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export const payrollRunNotFound = () => new ApiError(404, 'unknown_payroll_run', 'No such payroll run.');

const monthAlreadyRun = (month: string) => new ApiError(409, 'payroll_month_taken', `${monthLabel(month)} already has a payroll run. Cancel it before making another.`);

const historyRef = (runId: string) => ({ module: ACCOUNTS_MODULE_KEY, object: PAYROLL_RESOURCE, recordId: runId });

const fieldRulesFor = (actor: Actor) => readFieldRules(actor, ACCOUNTS_MODULE_KEY, PAYROLL_RESOURCE);

/** "2026-11" as "November 2026". */
export function monthLabel(month: string): string {
  const [year, monthNumber] = month.split('-').map(Number);
  return `${MONTH_NAMES[(monthNumber ?? 1) - 1]} ${year}`;
}

const daysInMonth = (month: string) => {
  const [year, monthNumber] = month.split('-').map(Number);
  return new Date(Date.UTC(year ?? 1970, monthNumber ?? 1, 0)).getUTCDate();
};

/**
 * A person's gross for the month: the monthly salary, or for someone who joined during the month, the share of
 * calendar days from their join date to the month's end, rounded to the paisa. Nobody who joins after the month is paid.
 */
export function grossForMonth(employee: Pick<AccountsEmployeeDoc, 'monthlySalary' | 'joinDate'>, month: string): number {
  const days = daysInMonth(month);
  const lastDay = `${month}-${String(days).padStart(2, '0')}`;
  if (employee.joinDate > lastDay) return 0;
  if (employee.joinDate < `${month}-01`) return employee.monthlySalary;
  const daysWorked = days - Number(employee.joinDate.slice(8, 10)) + 1;
  return Math.round((employee.monthlySalary * daysWorked) / days);
}

/** Every active employee with pay for the month, by employee code. */
async function linesForMonth(month: string): Promise<PayrollLine[]> {
  const employees = await AccountsEmployee.find({ isActive: true }).sort({ employeeCode: 1 }).lean();
  return employees.flatMap((employee) => {
    const gross = grossForMonth(employee, month);
    if (gross <= 0) return [];
    const isPartMonth = gross !== employee.monthlySalary;
    return [{
      employeeId: employee._id,
      employeeCode: employee.employeeCode,
      name: employee.name,
      department: employee.department,
      gross,
      ...(isPartMonth && { note: `Joined ${employee.joinDate}` }),
    }];
  });
}

const totalOf = (lines: PayrollLine[]) => lines.reduce((sum, line) => sum + line.gross, 0);

/** Salary expense per person against salaries payable: what recording the run writes. */
function ledgerLinesFor(run: Pick<PayrollRunDoc, 'lines' | 'total' | 'month' | 'number'>): NewLedgerLine[] {
  return [
    ...run.lines.map((line) => ({ accountId: POSTING_ACCOUNTS.salaryExpense, debit: line.gross, memo: `${line.employeeCode} ${line.name}` })),
    { accountId: POSTING_ACCOUNTS.salariesPayable, credit: run.total, memo: `${run.number} salaries, ${monthLabel(run.month)}` },
  ];
}

function assertStatus(run: PayrollRunDoc, allowed: PayrollRunStatus, action: string): void {
  if (run.status !== allowed) throw wrongDocumentStatus('payroll run', STATUS_LABELS[run.status], allowed, action);
}

async function requireRun(runId: string): Promise<PayrollRunDoc> {
  const run = await PayrollRun.findById(runId).lean();
  if (!run) throw payrollRunNotFound();
  return run;
}

async function peopleNamed(runs: PayrollRunDoc[]): Promise<Map<string, string>> {
  const ids = new Set(runs.flatMap((run) => [run.createdBy, run.submittedBy, run.approvedBy, run.cancelledBy]).filter((id): id is string => Boolean(id)));
  return new Map((await findUsersByIds([...ids])).map((person) => [person._id, person.name]));
}

const personRef = (id: string | undefined, names: Map<string, string>) => (id ? { id, name: names.get(id) } : undefined);

async function viewsOf(runs: PayrollRunDoc[], rules: FieldRules) {
  const [names, settled] = await Promise.all([peopleNamed(runs), sumSettledAmounts(runs.map((run) => run._id))]);
  return runs.map((run) => redactRecord({
    id: run._id,
    number: run.number,
    month: run.month,
    monthLabel: monthLabel(run.month),
    payDate: run.payDate,
    lines: run.lines,
    total: run.total,
    headcount: run.headcount,
    status: run.status,
    ...(run.status === 'recorded' && paymentStateOf(run.total, run.payDate, settled.get(run._id))),
    returnNote: run.returnNote,
    createdBy: personRef(run.createdBy, names),
    createdAt: run.createdAt,
    submittedBy: personRef(run.submittedBy, names),
    submittedAt: run.submittedAt,
    approvedBy: personRef(run.approvedBy, names),
    approvedAt: run.approvedAt,
    ledgerEntryId: run.ledgerEntryId,
    cancelledBy: personRef(run.cancelledBy, names),
    cancelledAt: run.cancelledAt,
    reversalEntryId: run.reversalEntryId,
    version: run.version,
    updatedAt: run.updatedAt,
  }, rules));
}

async function viewFor(actor: Actor, run: PayrollRunDoc) {
  const [view] = await viewsOf([run], await fieldRulesFor(actor));
  if (!view) throw new Error('Viewing a payroll run returned nothing.');
  return view;
}

const auditFields = (actor: Actor, run: PayrollRunDoc) => ({ ...actorFields(actor), targetType: PAYROLL_RESOURCE, targetId: run._id, targetName: `${run.number} ${monthLabel(run.month)}`, module: ACCOUNTS_MODULE_KEY });

async function changeRun(
  actor: Actor,
  existing: PayrollRunDoc,
  auditAction: string,
  buildUpdate: (session: ClientSession) => Promise<UpdateQuery<PayrollRunDoc>>,
  options: { version?: number; reason?: string } = {},
): Promise<PayrollRunDoc> {
  return runInTransaction(async (session) => {
    const update = await buildUpdate(session);
    const saved = await changeRecord(PayrollRun, existing._id, update, { actorId: actor.user._id, expectedVersion: options.version ?? existing.version, session }, payrollRunNotFound);
    await writeRecordHistory(historyRef(existing._id), { action: 'updated', actor, before: existing, after: saved, reason: options.reason }, session);
    await recordAudit({ action: auditAction, ...auditFields(actor, saved) }, session);
    return saved;
  });
}

export async function listPayrollRuns(actor: Actor, { status, ...page }: PageRequest & { status?: PayrollRunStatus }) {
  const filter = status ? { status } : {};
  const [runs, total] = await Promise.all([
    PayrollRun.find(filter).sort({ month: -1, number: -1 }).skip(pageOffset(page)).limit(page.pageSize).lean(),
    PayrollRun.countDocuments(filter),
  ]);
  return { total, page: page.page, pageSize: page.pageSize, runs: await viewsOf(runs, await fieldRulesFor(actor)) };
}

export async function getPayrollRun(actor: Actor, runId: string) {
  const run = await requireRun(runId);
  const [view, canDecide, payments] = await Promise.all([viewFor(actor, run), mayDecide(actor, run, APPROVE_PERMISSION), findVouchersLinkedTo(run._id)]);
  const canUpdate = Boolean(actor.permissions['payrollRun.update']);
  const hasPayments = payments.some((voucher) => voucher.status !== 'reversed');
  const isOwed = run.status === 'recorded' && 'outstanding' in view && Number(view.outstanding) - Number(view.pending ?? 0) > 0;
  return {
    ...view,
    payments: payments.map((voucher) => ({ id: voucher._id, number: voucher.number, voucherDate: voucher.voucherDate, amount: voucher.linkedDocument?.amount ?? 0, status: voucher.status })),
    allowedActions: {
      edit: canUpdate && run.status === 'draft',
      submit: canUpdate && run.status === 'draft',
      approve: canDecide && run.status === 'submitted',
      return: canDecide && run.status === 'submitted',
      cancel: (run.status === 'draft' && canUpdate) || (run.status === 'recorded' && canDecide && !hasPayments),
      pay: Boolean(actor.permissions['journalVoucher.create']) && isOwed,
    },
  };
}

/** Makes a month's draft run from the active employees. A month already run (and not cancelled) is refused. */
export async function createPayrollRun(actor: Actor, request: { month: string; payDate: string }) {
  if (await PayrollRun.exists({ month: request.month, status: { $ne: 'cancelled' } })) throw monthAlreadyRun(request.month);
  const lines = await linesForMonth(request.month);
  if (lines.length === 0) throw new ApiError(422, 'no_employees', `Nobody is employed in ${monthLabel(request.month)}, so there is nothing to pay.`);
  const number = await takeNextDocumentNumber('payrollRun', 'PR-');
  try {
    const run = await runInTransaction(async (session) => {
      const [created] = await PayrollRun.create([{
        _id: `pr_${randomUUID()}`, number, month: request.month, payDate: request.payDate, lines, total: totalOf(lines), headcount: lines.length,
        status: 'draft', createdBy: actor.user._id, updatedBy: actor.user._id,
      }], { session });
      if (!created) throw new Error('Creating the payroll run returned nothing.');
      const saved = created.toObject();
      await writeRecordHistory(historyRef(saved._id), { action: 'created', actor, after: saved }, session);
      await recordAudit({ action: 'payrollRun.created', ...auditFields(actor, saved) }, session);
      return saved;
    });
    return viewFor(actor, run);
  } catch (error) {
    // Someone made the same month's run at the same moment; the database's unique index refused this one.
    if (isDuplicateKeyError(error)) throw monthAlreadyRun(request.month);
    throw error;
  }
}

/**
 * Edits a draft, with a reason in its history: a new pay date, or changed amounts for named people (such as unpaid
 * leave). `adjustments` set a person's gross for this run only; a gross of 0 takes them off it.
 */
export async function updatePayrollRun(
  actor: Actor,
  runId: string,
  request: { payDate?: string; adjustments?: { employeeId: string; gross: number; note?: string }[]; reason: string; version?: number },
) {
  const existing = await requireRun(runId);
  assertStatus(existing, 'draft', 'edited');
  // Salaries are a protected field: changing one needs edit access to the lines, as reading them needs read access.
  assertMayWriteFields(await fieldRulesFor(actor), [...(request.payDate ? ['payDate'] : []), ...(request.adjustments ? ['lines'] : [])], 'update');
  let lines = existing.lines;
  for (const [index, adjustment] of (request.adjustments ?? []).entries()) {
    if (!lines.some((line) => line.employeeId === adjustment.employeeId)) {
      throw new ApiError(422, 'validation_failed', 'Some adjustments are invalid.', [{ path: `adjustments.${index}.employeeId`, message: 'isn\'t on this run' }]);
    }
    lines = lines.flatMap((line) => {
      if (line.employeeId !== adjustment.employeeId) return [line];
      return adjustment.gross > 0 ? [{ ...line, gross: adjustment.gross, ...(adjustment.note && { note: adjustment.note }) }] : [];
    });
  }
  if (lines.length === 0) throw new ApiError(422, 'validation_failed', 'Some adjustments are invalid.', [{ path: 'adjustments', message: 'would leave nobody on the run' }]);
  const saved = await changeRun(actor, existing, 'payrollRun.updated', async () => ({
    $set: { ...(request.payDate && { payDate: request.payDate }), lines, total: totalOf(lines), headcount: lines.length },
  }), { version: request.version, reason: request.reason });
  return viewFor(actor, saved);
}

export async function submitPayrollRun(actor: Actor, runId: string, version?: number) {
  const existing = await requireRun(runId);
  assertStatus(existing, 'draft', 'submitted');
  const saved = await changeRun(actor, existing, 'payrollRun.submitted', async () => ({
    $set: { status: 'submitted', submittedBy: actor.user._id, submittedAt: new Date() },
    $unset: { returnNote: 1 },
  }), { version });
  return viewFor(actor, saved);
}

/** Approves a submitted run and records salary expense per person against salaries payable, dated the pay date. */
export async function approvePayrollRun(actor: Actor, runId: string, version?: number) {
  const existing = await requireRun(runId);
  assertStatus(existing, 'submitted', 'approved');
  await assertMayDecide(actor, existing, APPROVE_PERMISSION);
  const saved = await changeRun(actor, existing, 'payrollRun.approved', async (session) => {
    const entry = await postEntry(actor, {
      entryDate: existing.payDate,
      memo: `${existing.number} salaries, ${monthLabel(existing.month)}`,
      source: { type: PAYROLL_RESOURCE, id: existing._id },
      lines: ledgerLinesFor(existing),
    }, session);
    return { $set: { status: 'recorded', approvedBy: actor.user._id, approvedAt: new Date(), ledgerEntryId: entry._id } };
  }, { version });
  return viewFor(actor, saved);
}

export async function returnPayrollRun(actor: Actor, runId: string, request: { note: string; version?: number }) {
  const existing = await requireRun(runId);
  assertStatus(existing, 'submitted', 'returned');
  await assertMayDecide(actor, existing, APPROVE_PERMISSION);
  const saved = await changeRun(actor, existing, 'payrollRun.returned', async () => ({
    $set: { status: 'draft', returnNote: request.note },
    $unset: { submittedBy: 1, submittedAt: 1 },
  }), { version: request.version });
  return viewFor(actor, saved);
}

/** Gives up a draft, or cancels a recorded run with a reversal dated today; refused while it has payments. */
export async function cancelPayrollRun(actor: Actor, runId: string, request: { reason: string; version?: number }) {
  const existing = await requireRun(runId);
  if (existing.status !== 'draft' && existing.status !== 'recorded') throw wrongDocumentStatus('payroll run', STATUS_LABELS[existing.status], 'draft', 'cancelled');
  const cancelled = { status: 'cancelled', cancelledBy: actor.user._id, cancelledAt: new Date() };
  if (existing.status === 'draft') {
    if (!actor.permissions['payrollRun.update']) throw new ApiError(403, 'forbidden', "Your profile doesn't let you change payroll runs.");
    const saved = await changeRun(actor, existing, 'payrollRun.cancelled', async () => ({ $set: cancelled }), { version: request.version, reason: request.reason });
    return viewFor(actor, saved);
  }
  await assertMayDecide(actor, existing, APPROVE_PERMISSION);
  if (((await sumSettledAmounts([existing._id])).get(existing._id)?.committed ?? 0) > 0) {
    throw new ApiError(409, 'payroll_run_has_payments', `${existing.number} has payments. Reverse them before cancelling it.`);
  }
  const ledgerEntryId = existing.ledgerEntryId;
  if (!ledgerEntryId) throw new Error(`Recorded payroll run ${existing._id} has no ledger entry.`);
  const saved = await changeRun(actor, existing, 'payrollRun.cancelled', async (session) => {
    const reversal = await reverseEntry(actor, ledgerEntryId, session, { memo: `Cancels ${existing.number}: ${request.reason}` });
    return { $set: { ...cancelled, reversalEntryId: reversal._id } };
  }, { version: request.version, reason: request.reason });
  return viewFor(actor, saved);
}

/** Makes one draft payment voucher for a recorded run: salaries payable cleared from a bank account. Defaults to all that is open. */
export async function payPayrollRun(actor: Actor, runId: string, request: { paymentDate: string; moneyAccountId: string; amount?: number; reference?: string }) {
  const run = await requireRun(runId);
  assertStatus(run, 'recorded', 'paid');
  const settled = (await sumSettledAmounts([run._id])).get(run._id);
  const amount = request.amount ?? run.total - (settled?.committed ?? 0);
  if (amount <= 0) throw new ApiError(409, 'nothing_owed', `Nothing is open on ${run.number}: it is paid, or payments for the rest are waiting for approval.`);
  assertWithinOpenAmount(amount, run.total, settled, run.number);
  return createLinkedVoucher(actor, 'payment', {
    voucherDate: request.paymentDate,
    memo: `Salaries, ${monthLabel(run.month)} (${run.number})`,
    party: `${run.headcount} employees`,
    ...(request.reference && { reference: request.reference }),
    moneyAccountId: request.moneyAccountId,
    lines: [
      { accountId: POSTING_ACCOUNTS.salariesPayable, debit: amount, memo: run.number },
      { accountId: request.moneyAccountId, credit: amount, memo: 'Paid out' },
    ],
    linkedDocument: { type: 'payrollRun', id: run._id, number: run.number, amount },
  });
}

export async function getPayrollRunHistory(actor: Actor, runId: string, page: PageRequest) {
  await requireRun(runId);
  const history = await listRecordHistory(historyRef(runId), page);
  return { ...history, entries: redactHistory(history.entries, await fieldRulesFor(actor)) };
}

export async function findSubmittedPayrollRuns(creator: { notMadeBy: string } | { madeBy: string }, limit: number) {
  const filter = { status: 'submitted' as const, createdBy: 'madeBy' in creator ? creator.madeBy : { $ne: creator.notMadeBy } };
  const [runs, total] = await Promise.all([PayrollRun.find(filter).sort({ submittedAt: 1, number: 1 }).limit(limit).lean(), PayrollRun.countDocuments(filter)]);
  return { runs, total };
}
