import type { Actor } from '../../master/access/caller.js';
import { readFieldRules } from '../../master/records/fieldSecurity.service.js';
import { ACCOUNTS_MODULE_KEY } from '../accountsModule.js';
import { paymentStateOf } from '../documents/documentState.js';
import { sumSettledAmounts } from '../journalVoucher/journalVoucher.repository.js';
import { AccountsEmployee } from '../models/accountsEmployee.js';
import { PayrollRun } from '../models/payrollRun.js';
import { StaffPayout } from '../models/staffPayout.js';
import { monthLabel } from '../payroll/payroll.service.js';

/*
 * What each payroll employee received: salary from recorded payroll runs, and bonus and commission from recorded
 * payouts, with whether each has been paid out of the bank. Read from those records, so it always agrees with them.
 * Salaries show only to profiles allowed to see the payroll run's protected lines.
 */

export type EmployeePaymentType = 'salary' | 'bonus' | 'commission';

export interface EmployeePayment {
  employeeId: string;
  employeeName: string;
  type: EmployeePaymentType;
  /** What it was for, such as "November 2026" or "Year-end bonus". */
  forWhat: string;
  /** YYYY-MM-DD: the pay date. */
  date: string;
  /** Paisa. */
  amount: number;
  record: { type: 'payrollRun' | 'staffPayout'; id: string; number: string };
  /** Whether the whole run or payout has been paid from the bank. */
  isPaid: boolean;
}

export async function listEmployeePayments(actor: Actor, query: { employeeId?: string; from?: string; to?: string }) {
  const dates = { ...(query.from && { $gte: query.from }), ...(query.to && { $lte: query.to }) };
  const hasDates = Object.keys(dates).length > 0;
  const payrollRules = await readFieldRules(actor, ACCOUNTS_MODULE_KEY, 'payrollRun');
  const maySeeSalaries = Boolean(actor.permissions['payrollRun.read']) && !payrollRules.hidden.includes('lines');
  const maySeePayouts = Boolean(actor.permissions['staffPayout.read']);

  const [runs, payouts, employees] = await Promise.all([
    maySeeSalaries ? PayrollRun.find({ status: 'recorded', ...(hasDates && { payDate: dates }), ...(query.employeeId && { 'lines.employeeId': query.employeeId }) }).lean() : [],
    maySeePayouts ? StaffPayout.find({ status: 'recorded', kind: { $in: ['bonus', 'commission'] }, ...(hasDates && { payDate: dates }), ...(query.employeeId && { 'lines.payeeId': query.employeeId }) }).lean() : [],
    AccountsEmployee.find().select('employeeCode name designation department joinDate isActive').sort({ employeeCode: 1 }).lean(),
  ]);
  const settled = await sumSettledAmounts([...runs.map((run) => run._id), ...payouts.map((payout) => payout._id)]);
  const isPaid = (id: string, total: number, dueDate: string) => paymentStateOf(total, dueDate, settled.get(id)).paymentStatus === 'paid';

  const payments: EmployeePayment[] = [
    ...runs.flatMap((run) => run.lines
      .filter((line) => !query.employeeId || line.employeeId === query.employeeId)
      .map((line) => ({
        employeeId: line.employeeId, employeeName: line.name, type: 'salary' as const, forWhat: monthLabel(run.month), date: run.payDate, amount: line.gross,
        record: { type: 'payrollRun' as const, id: run._id, number: run.number }, isPaid: isPaid(run._id, run.total, run.payDate),
      }))),
    ...payouts.flatMap((payout) => payout.lines
      .filter((line) => line.payeeType === 'employee' && (!query.employeeId || line.payeeId === query.employeeId))
      .map((line) => ({
        employeeId: line.payeeId, employeeName: line.name, type: payout.kind as EmployeePaymentType, forWhat: payout.title, date: payout.payDate, amount: line.amount,
        record: { type: 'staffPayout' as const, id: payout._id, number: payout.number }, isPaid: isPaid(payout._id, payout.total, payout.payDate),
      }))),
  ].sort((first, second) => second.date.localeCompare(first.date) || first.employeeName.localeCompare(second.employeeName));

  const totals = { salary: 0, bonus: 0, commission: 0 };
  for (const payment of payments) totals[payment.type] += payment.amount;
  return {
    maySeeSalaries,
    totals,
    employees: employees.map((employee) => ({ id: employee._id, code: employee.employeeCode, name: employee.name, designation: employee.designation, department: employee.department, joinDate: employee.joinDate, isActive: employee.isActive })),
    payments,
  };
}
