import type { LoanRepayment } from '../models/payrollRun.js';
import { PayrollRun } from '../models/payrollRun.js';
import { EmployeeLoan, type EmployeeLoanDoc } from '../models/employeeLoan.js';
import { addMonths } from '../fixedAsset/depreciation.js';
import { sumSettledAmounts } from '../journalVoucher/journalVoucher.repository.js';

/*
 * Loans are repaid only through payroll: each run takes the month's instalment from the person's pay. What a loan has
 * been repaid is read back from payroll runs, never stored, so it always agrees with the books.
 */

export interface LoanRepaid {
  /** Paisa repaid in recorded payroll runs. */
  repaid: number;
  /** Paisa taken by runs not yet recorded (drafts and those waiting for approval). */
  pending: number;
  /** Each run that took an instalment, oldest first. */
  repayments: { runId: string; runNumber: string; month: string; amount: number; recorded: boolean }[];
}

/** Repayments per loan across payroll runs that aren't cancelled. */
export async function sumRepayments(loanIds: string[]): Promise<Map<string, LoanRepaid>> {
  const runs = await PayrollRun.find({ status: { $ne: 'cancelled' }, 'lines.loanRepayments.loanId': { $in: loanIds } }).sort({ month: 1 }).select('number month status lines').lean();
  const result = new Map<string, LoanRepaid>(loanIds.map((id) => [id, { repaid: 0, pending: 0, repayments: [] }]));
  for (const run of runs) {
    for (const line of run.lines) {
      for (const repayment of line.loanRepayments ?? []) {
        const loan = result.get(repayment.loanId);
        if (!loan) continue;
        const recorded = run.status === 'recorded';
        if (recorded) loan.repaid += repayment.amount;
        else loan.pending += repayment.amount;
        loan.repayments.push({ runId: run._id, runNumber: run.number, month: run.month, amount: repayment.amount, recorded });
      }
    }
  }
  return result;
}

/**
 * This month's instalment on every recorded loan whose repayments have started and that isn't repaid yet, by employee:
 * the monthly instalment, or what is left when that is less. Runs that aren't cancelled count, so two runs never take
 * the same money. Only money actually paid out (recorded payment vouchers) is repaid, so a loan approved but not yet
 * given to the employee takes nothing from their pay.
 */
export async function findDueRepayments(month: string): Promise<Map<string, LoanRepayment[]>> {
  const loans = await EmployeeLoan.find({ status: 'recorded', firstRepaymentMonth: { $lte: month } }).sort({ issueDate: 1, number: 1 }).lean();
  const loanIds = loans.map((loan) => loan._id);
  const [repaid, paidOut] = await Promise.all([sumRepayments(loanIds), sumSettledAmounts(loanIds)]);
  const due = new Map<string, LoanRepayment[]>();
  for (const loan of loans) {
    const taken = (repaid.get(loan._id)?.repaid ?? 0) + (repaid.get(loan._id)?.pending ?? 0);
    const amount = Math.min(loan.monthlyInstallment, (paidOut.get(loan._id)?.recorded ?? 0) - taken);
    if (amount > 0) due.set(loan.employeeId, [...(due.get(loan.employeeId) ?? []), { loanId: loan._id, number: loan.number, amount }]);
  }
  return due;
}

/** The planned repayments, month by month from the first: the instalment, and what is left in the last month. */
export function repaymentSchedule(loan: Pick<EmployeeLoanDoc, 'amount' | 'monthlyInstallment' | 'firstRepaymentMonth'>): { month: string; amount: number }[] {
  const months = Math.ceil(loan.amount / loan.monthlyInstallment);
  return Array.from({ length: months }, (_unused, index) => ({
    month: addMonths(loan.firstRepaymentMonth, index),
    amount: index === months - 1 ? loan.amount - loan.monthlyInstallment * (months - 1) : loan.monthlyInstallment,
  }));
}

/** The month the last instalment falls in, if every payroll takes one. */
export const lastRepaymentMonth = (loan: Pick<EmployeeLoanDoc, 'amount' | 'monthlyInstallment' | 'firstRepaymentMonth'>) =>
  addMonths(loan.firstRepaymentMonth, Math.ceil(loan.amount / loan.monthlyInstallment) - 1);

