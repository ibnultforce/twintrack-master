import { randomUUID } from 'node:crypto';
import type { ClientSession, UpdateQuery } from 'mongoose';
import { runInTransaction } from '../../../db.js';
import { ApiError } from '../../../lib/errors.js';
import { pageOffset, type PageRequest } from '../../../lib/query.js';
import { changeRecord } from '../../../lib/records/recordWrites.js';
import { actorFields, type Actor } from '../../master/access/caller.js';
import { recordAudit } from '../../master/audit/audit.repository.js';
import { listRecordHistory, writeRecordHistory } from '../../master/records/recordHistory.service.js';
import { findUsersByIds } from '../../master/users/users.repository.js';
import { ACCOUNTS_MODULE_KEY } from '../accountsModule.js';
import { assertMayDecide, mayDecide } from '../approvals/approvalRules.js';
import { takeNextDocumentNumber } from '../documentNumbers.js';
import { assertWithinOpenAmount, paymentStateOf, wrongDocumentStatus } from '../documents/documentState.js';
import { findVouchersLinkedTo, sumSettledAmounts } from '../journalVoucher/journalVoucher.repository.js';
import { createLinkedVoucher } from '../journalVoucher/journalVoucher.service.js';
import { postEntry, reverseEntry } from '../ledger/ledger.service.js';
import { AccountsEmployee } from '../models/accountsEmployee.js';
import { EmployeeLoan, type EmployeeLoanDoc, type LoanKind, type LoanStatus, UnpaidLeave } from '../models/employeeLoan.js';
import { PayrollRun } from '../models/payrollRun.js';
import { leaveDeductionFor, monthLabel } from '../payroll/payroll.service.js';
import { POSTING_ACCOUNTS } from '../postingAccounts.js';
import { lastRepaymentMonth, repaymentSchedule, sumRepayments } from './loanRepayments.js';

const RESOURCE = 'employeeLoan';
const APPROVE_PERMISSION = 'employeeLoan.approve';

const STATUS_LABELS: Record<LoanStatus, string> = { draft: 'a draft', submitted: 'waiting for approval', recorded: 'recorded', cancelled: 'cancelled' };

export const employeeLoanNotFound = () => new ApiError(404, 'unknown_employee_loan', 'No such loan or advance.');

const invalid = (path: string, message: string) => new ApiError(422, 'validation_failed', 'Some fields are invalid.', [{ path, message }]);

const historyRef = (loanId: string) => ({ module: ACCOUNTS_MODULE_KEY, object: RESOURCE, recordId: loanId });

function assertStatus(loan: EmployeeLoanDoc, allowed: LoanStatus, action: string): void {
  if (loan.status !== allowed) throw wrongDocumentStatus('loan', STATUS_LABELS[loan.status], allowed, action);
}

async function requireLoan(loanId: string): Promise<EmployeeLoanDoc> {
  const loan = await EmployeeLoan.findById(loanId).lean();
  if (!loan) throw employeeLoanNotFound();
  return loan;
}

async function viewsOf(loans: EmployeeLoanDoc[]) {
  const ids = loans.map((loan) => loan._id);
  const [repaid, settled, people] = await Promise.all([
    sumRepayments(ids),
    sumSettledAmounts(ids),
    findUsersByIds([...new Set(loans.flatMap((loan) => [loan.createdBy, loan.approvedBy].filter((id): id is string => Boolean(id))))]),
  ]);
  const names = new Map(people.map((person) => [person._id, person.name]));
  return loans.map((loan) => {
    const repayment = repaid.get(loan._id) ?? { repaid: 0, pending: 0, repayments: [] };
    const isLive = loan.status === 'recorded';
    return {
      id: loan._id,
      number: loan.number,
      employeeId: loan.employeeId,
      employeeName: loan.employeeName,
      kind: loan.kind,
      purpose: loan.purpose,
      issueDate: loan.issueDate,
      amount: loan.amount,
      monthlyInstallment: loan.monthlyInstallment,
      firstRepaymentMonth: loan.firstRepaymentMonth,
      lastRepaymentMonth: lastRepaymentMonth(loan),
      status: loan.status,
      // Paid out to the employee, from the linked payment voucher.
      ...(isLive && { payout: paymentStateOf(loan.amount, loan.issueDate, settled.get(loan._id)) }),
      repaid: repayment.repaid,
      repaymentPending: repayment.pending,
      // What the employee still owes: the amount less repayments in recorded payroll runs.
      outstanding: isLive ? loan.amount - repayment.repaid : 0,
      repayments: repayment.repayments,
      returnNote: loan.returnNote,
      createdBy: loan.createdBy ? { id: loan.createdBy, name: names.get(loan.createdBy) } : undefined,
      createdAt: loan.createdAt,
      approvedBy: loan.approvedBy ? { id: loan.approvedBy, name: names.get(loan.approvedBy) } : undefined,
      approvedAt: loan.approvedAt,
      version: loan.version,
    };
  });
}

async function viewFor(loan: EmployeeLoanDoc) {
  const [view] = await viewsOf([loan]);
  if (!view) throw new Error('Viewing a loan returned nothing.');
  return view;
}

const auditFields = (actor: Actor, loan: EmployeeLoanDoc) => ({ ...actorFields(actor), targetType: RESOURCE, targetId: loan._id, targetName: `${loan.number} ${loan.employeeName}`, module: ACCOUNTS_MODULE_KEY });

async function changeLoan(actor: Actor, existing: EmployeeLoanDoc, auditAction: string, buildUpdate: (session: ClientSession) => Promise<UpdateQuery<EmployeeLoanDoc>>, options: { version?: number; reason?: string } = {}) {
  return runInTransaction(async (session) => {
    const update = await buildUpdate(session);
    const saved = await changeRecord(EmployeeLoan, existing._id, update, { actorId: actor.user._id, expectedVersion: options.version ?? existing.version, session }, employeeLoanNotFound);
    await writeRecordHistory(historyRef(existing._id), { action: 'updated', actor, before: existing, after: saved, reason: options.reason }, session);
    await recordAudit({ action: auditAction, ...auditFields(actor, saved) }, session);
    return saved;
  });
}

export async function listEmployeeLoans({ status, employeeId, ...page }: PageRequest & { status?: LoanStatus; employeeId?: string }) {
  const filter = { ...(status && { status }), ...(employeeId && { employeeId }) };
  const [loans, total] = await Promise.all([
    EmployeeLoan.find(filter).sort({ issueDate: -1, number: -1 }).skip(pageOffset(page)).limit(page.pageSize).lean(),
    EmployeeLoan.countDocuments(filter),
  ]);
  return { total, page: page.page, pageSize: page.pageSize, loans: await viewsOf(loans) };
}

/** One loan with its planned schedule beside what payroll actually took, and the actions the caller may take. */
export async function getEmployeeLoan(actor: Actor, loanId: string) {
  const loan = await requireLoan(loanId);
  const [view, canDecide, payments] = await Promise.all([viewFor(loan), mayDecide(actor, loan, APPROVE_PERMISSION), findVouchersLinkedTo(loan._id)]);
  const canUpdate = Boolean(actor.permissions['employeeLoan.update']);
  const isOwedToEmployee = loan.status === 'recorded' && view.payout !== undefined && view.payout.outstanding - view.payout.pending > 0;
  return {
    ...view,
    schedule: repaymentSchedule(loan).map((row) => {
      const actual = view.repayments.find((repayment) => repayment.month === row.month);
      return { ...row, monthLabel: monthLabel(row.month), ...(actual && { taken: actual }) };
    }),
    payments: payments.map((voucher) => ({ id: voucher._id, number: voucher.number, voucherDate: voucher.voucherDate, amount: voucher.linkedDocument?.amount ?? 0, status: voucher.status })),
    allowedActions: {
      submit: canUpdate && loan.status === 'draft',
      approve: canDecide && loan.status === 'submitted',
      return: canDecide && loan.status === 'submitted',
      cancel: (loan.status === 'draft' && canUpdate) || (loan.status === 'recorded' && canDecide && payments.every((voucher) => voucher.status === 'reversed') && view.repaid + view.repaymentPending === 0),
      pay: Boolean(actor.permissions['journalVoucher.create']) && isOwedToEmployee,
    },
  };
}

export interface LoanDetails {
  employeeId: string;
  kind: LoanKind;
  purpose: string;
  issueDate: string;
  amount: number;
  monthlyInstallment: number;
  firstRepaymentMonth: string;
}

export async function createEmployeeLoan(actor: Actor, details: LoanDetails) {
  const employee = await AccountsEmployee.findOne({ _id: details.employeeId, isActive: true }).lean();
  if (!employee) throw invalid('employeeId', 'no such active employee');
  if (details.monthlyInstallment > details.amount) throw invalid('monthlyInstallment', 'must not be more than the amount');
  if (details.firstRepaymentMonth < details.issueDate.slice(0, 7)) throw invalid('firstRepaymentMonth', 'must not be before the month it is given');
  const number = await takeNextDocumentNumber('employeeLoan', 'LN-');
  const loan = await runInTransaction(async (session) => {
    const [created] = await EmployeeLoan.create([{ _id: `ln_${randomUUID()}`, number, ...details, employeeName: employee.name, status: 'draft', createdBy: actor.user._id, updatedBy: actor.user._id }], { session });
    if (!created) throw new Error('Creating the loan returned nothing.');
    const saved = created.toObject();
    await writeRecordHistory(historyRef(saved._id), { action: 'created', actor, after: saved }, session);
    await recordAudit({ action: 'employeeLoan.created', ...auditFields(actor, saved) }, session);
    return saved;
  });
  return viewFor(loan);
}

export async function submitEmployeeLoan(actor: Actor, loanId: string, version?: number) {
  const existing = await requireLoan(loanId);
  assertStatus(existing, 'draft', 'submitted');
  return viewFor(await changeLoan(actor, existing, 'employeeLoan.submitted', async () => ({ $set: { status: 'submitted', submittedBy: actor.user._id, submittedAt: new Date() }, $unset: { returnNote: 1 } }), { version }));
}

/** Approves it and records what the employee owes (1400) against what the company must pay them (2200), on the issue date. */
export async function approveEmployeeLoan(actor: Actor, loanId: string, version?: number) {
  const existing = await requireLoan(loanId);
  assertStatus(existing, 'submitted', 'approved');
  await assertMayDecide(actor, existing, APPROVE_PERMISSION);
  return viewFor(await changeLoan(actor, existing, 'employeeLoan.approved', async (session) => {
    const entry = await postEntry(actor, {
      entryDate: existing.issueDate,
      memo: `${existing.number} ${existing.kind} to ${existing.employeeName}`,
      source: { type: RESOURCE, id: existing._id },
      lines: [
        { accountId: POSTING_ACCOUNTS.employeeLoans, debit: existing.amount, memo: `${existing.number} ${existing.employeeName}` },
        { accountId: POSTING_ACCOUNTS.salariesPayable, credit: existing.amount, memo: `${existing.number} to pay out` },
      ],
    }, session);
    return { $set: { status: 'recorded', approvedBy: actor.user._id, approvedAt: new Date(), ledgerEntryId: entry._id } };
  }, { version }));
}

export async function returnEmployeeLoan(actor: Actor, loanId: string, request: { note: string; version?: number }) {
  const existing = await requireLoan(loanId);
  assertStatus(existing, 'submitted', 'returned');
  await assertMayDecide(actor, existing, APPROVE_PERMISSION);
  return viewFor(await changeLoan(actor, existing, 'employeeLoan.returned', async () => ({ $set: { status: 'draft', returnNote: request.note }, $unset: { submittedBy: 1, submittedAt: 1 } }), { version: request.version }));
}

/** Gives up a draft, or reverses a recorded loan that was never paid out or repaid. */
export async function cancelEmployeeLoan(actor: Actor, loanId: string, request: { reason: string; version?: number }) {
  const existing = await requireLoan(loanId);
  const cancelled = { status: 'cancelled', cancelledBy: actor.user._id, cancelledAt: new Date() };
  if (existing.status === 'draft') {
    if (!actor.permissions['employeeLoan.update']) throw new ApiError(403, 'forbidden', "Your profile doesn't let you change loans.");
    return viewFor(await changeLoan(actor, existing, 'employeeLoan.cancelled', async () => ({ $set: cancelled }), { version: request.version, reason: request.reason }));
  }
  if (existing.status !== 'recorded') throw wrongDocumentStatus('loan', STATUS_LABELS[existing.status], 'draft', 'cancelled');
  await assertMayDecide(actor, existing, APPROVE_PERMISSION);
  const [settled, repaid] = await Promise.all([sumSettledAmounts([existing._id]), sumRepayments([existing._id])]);
  const repayment = repaid.get(existing._id);
  if ((settled.get(existing._id)?.committed ?? 0) > 0 || (repayment?.repaid ?? 0) + (repayment?.pending ?? 0) > 0) {
    throw new ApiError(409, 'loan_in_use', `${existing.number} has been paid out or repaid through payroll, so it can't be cancelled.`);
  }
  const ledgerEntryId = existing.ledgerEntryId;
  if (!ledgerEntryId) throw new Error(`Recorded loan ${existing._id} has no ledger entry.`);
  return viewFor(await changeLoan(actor, existing, 'employeeLoan.cancelled', async (session) => {
    const reversal = await reverseEntry(actor, ledgerEntryId, session, { memo: `Cancels ${existing.number}: ${request.reason}` });
    return { $set: { ...cancelled, reversalEntryId: reversal._id } };
  }, { version: request.version, reason: request.reason }));
}

/** Pays the loan out to the employee: a draft payment voucher clearing what the company owes them, from a bank account. */
export async function payEmployeeLoan(actor: Actor, loanId: string, request: { paymentDate: string; moneyAccountId: string; amount?: number; reference?: string }) {
  const loan = await requireLoan(loanId);
  assertStatus(loan, 'recorded', 'paid');
  const settled = (await sumSettledAmounts([loan._id])).get(loan._id);
  const amount = request.amount ?? loan.amount - (settled?.committed ?? 0);
  if (amount <= 0) throw new ApiError(409, 'nothing_owed', `${loan.number} is already paid out.`);
  assertWithinOpenAmount(amount, loan.amount, settled, loan.number);
  return createLinkedVoucher(actor, 'payment', {
    voucherDate: request.paymentDate,
    memo: `${loan.kind === 'loan' ? 'Loan' : 'Advance'} ${loan.number}: ${loan.purpose}`,
    party: loan.employeeName,
    ...(request.reference && { reference: request.reference }),
    moneyAccountId: request.moneyAccountId,
    lines: [
      { accountId: POSTING_ACCOUNTS.salariesPayable, debit: amount, memo: loan.number },
      { accountId: request.moneyAccountId, credit: amount, memo: 'Paid out' },
    ],
    linkedDocument: { type: 'employeeLoan', id: loan._id, number: loan.number, amount, amountDue: loan.amount },
  });
}

export async function getEmployeeLoanHistory(loanId: string, page: PageRequest) {
  await requireLoan(loanId);
  return listRecordHistory(historyRef(loanId), page);
}

export async function findSubmittedEmployeeLoans(creator: { notMadeBy: string } | { madeBy: string }, limit: number) {
  const filter = { status: 'submitted' as const, createdBy: 'madeBy' in creator ? creator.madeBy : { $ne: creator.notMadeBy } };
  const [loans, total] = await Promise.all([EmployeeLoan.find(filter).sort({ submittedAt: 1, number: 1 }).limit(limit).lean(), EmployeeLoan.countDocuments(filter)]);
  return { loans, total };
}

/** Each active employee's unpaid leave for a month, with a day's pay and what payroll will take off. */
export async function listUnpaidLeave(month: string) {
  const [employees, leave] = await Promise.all([
    AccountsEmployee.find({ isActive: true }).sort({ employeeCode: 1 }).lean(),
    UnpaidLeave.find({ month }).lean(),
  ]);
  const byEmployee = new Map(leave.map((entry) => [entry.employeeId, entry]));
  const rows = employees.map((employee) => {
    const entry = byEmployee.get(employee._id);
    const dailyRate = leaveDeductionFor(employee.monthlySalary, 1, employee.monthlySalary);
    return {
      employeeId: employee._id,
      employeeCode: employee.employeeCode,
      name: employee.name,
      department: employee.department,
      dailyRate,
      days: entry?.days ?? 0,
      deduction: entry ? leaveDeductionFor(employee.monthlySalary, entry.days, employee.monthlySalary) : 0,
      note: entry?.note,
      version: entry?.version,
    };
  });
  return { month, monthLabel: monthLabel(month), total: rows.reduce((sum, row) => sum + row.deduction, 0), employees: rows };
}

/**
 * Sets a person's unpaid leave days for a month (0 removes it). Refused once the month has a payroll run that isn't
 * cancelled, since the run already took the leave as it was; cancel the run, change the leave, and make it again.
 */
export async function setUnpaidLeave(actor: Actor, employeeId: string, month: string, request: { days: number; note?: string }) {
  const employee = await AccountsEmployee.findOne({ _id: employeeId, isActive: true }).lean();
  if (!employee) throw new ApiError(404, 'unknown_employee', 'No such active employee.');
  if (await PayrollRun.exists({ month, status: { $ne: 'cancelled' } })) {
    throw new ApiError(409, 'payroll_run_exists', `${monthLabel(month)} already has a payroll run. Cancel it to change its leave.`);
  }
  const id = `${employeeId}:${month}`;
  await runInTransaction(async (session) => {
    const before = await UnpaidLeave.findById(id).session(session).lean();
    if (request.days === 0) {
      await UnpaidLeave.deleteOne({ _id: id }, { session });
    } else if (before) {
      await UnpaidLeave.updateOne(
        { _id: id },
        { $set: { days: request.days, updatedBy: actor.user._id, ...(request.note ? { note: request.note } : {}) }, $inc: { version: 1 }, ...(!request.note && { $unset: { note: 1 } }) },
        { session },
      );
    } else {
      await UnpaidLeave.create([{ _id: id, employeeId, month, days: request.days, ...(request.note && { note: request.note }), createdBy: actor.user._id, updatedBy: actor.user._id, version: 0 }], { session });
    }
    await recordAudit({ action: 'unpaidLeave.updated', ...actorFields(actor), targetType: 'unpaidLeave', targetId: id, targetName: `${employee.name}, ${monthLabel(month)}: ${request.days} days`, module: ACCOUNTS_MODULE_KEY }, session);
  });
  return listUnpaidLeave(month);
}
