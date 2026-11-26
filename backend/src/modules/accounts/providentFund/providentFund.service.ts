import { ApiError } from '../../../lib/errors.js';
import type { Actor } from '../../master/access/caller.js';
import { assertWithinOpenAmount, paymentStateOf } from '../documents/documentState.js';
import { financialYearLabel, financialYearOf, financialYearRange } from '../financialYear.js';
import { sumSettledAmounts } from '../journalVoucher/journalVoucher.repository.js';
import { createLinkedVoucher } from '../journalVoucher/journalVoucher.service.js';
import { todayAsEntryDate } from '../ledger/ledger.service.js';
import { PayrollRun, type PayrollRunDoc } from '../models/payrollRun.js';
import { monthLabel } from '../payroll/payroll.service.js';
import { POSTING_ACCOUNTS } from '../postingAccounts.js';

/*
 * Provident fund and gratuity are worked out from recorded payroll runs, never stored: each line holds the employee's
 * provident fund share (the company adds the same) and the gratuity set aside. A month's fund is deposited with a
 * payment voucher linked to that month, so whether it is deposited always agrees with the books.
 */

/** The agreed rules give the fund no deposit deadline, so a month is never shown as overdue. */
const NO_DEADLINE = '9999-12-31';

const fundDocumentId = (month: string) => `pf_${month}`;

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

/** One month's fund per run: who is in it, both shares, the gratuity set aside, and how much is deposited. */
async function fundMonthsOf(runs: PayrollRunDoc[]) {
  const settled = await sumSettledAmounts(runs.map((run) => fundDocumentId(run.month)));
  return runs.map((run) => {
    const employeeShare = sum(run.lines.map((line) => line.providentFund ?? 0));
    const total = employeeShare * 2;
    return {
      month: run.month,
      monthLabel: monthLabel(run.month),
      runId: run._id,
      runNumber: run.number,
      members: run.lines.filter((line) => (line.providentFund ?? 0) > 0).length,
      headcount: run.headcount,
      employeeShare,
      companyShare: employeeShare,
      total,
      gratuity: sum(run.lines.map((line) => line.gratuity ?? 0)),
      ...paymentStateOf(total, NO_DEADLINE, settled.get(fundDocumentId(run.month))),
    };
  });
}

/**
 * A financial year's provident fund month by month, and each person's fund and gratuity built up across every
 * recorded run so far. Gratuity is paid when someone leaves, which isn't built yet, so it only builds up.
 */
export async function getProvidentFund(year = financialYearOf(todayAsEntryDate())) {
  const range = financialYearRange(year);
  const [yearRuns, allRuns] = await Promise.all([
    PayrollRun.find({ status: 'recorded', month: { $gte: range.from.slice(0, 7), $lte: range.to.slice(0, 7) } }).sort({ month: 1 }).lean(),
    PayrollRun.find({ status: 'recorded' }).select('lines').lean(),
  ]);
  const people = new Map<string, { employeeId: string; employeeCode: string; name: string; providentFund: number; gratuity: number }>();
  for (const line of allRuns.flatMap((run) => run.lines)) {
    const person = people.get(line.employeeId) ?? { employeeId: line.employeeId, employeeCode: line.employeeCode, name: line.name, providentFund: 0, gratuity: 0 };
    person.providentFund += (line.providentFund ?? 0) * 2;
    person.gratuity += line.gratuity ?? 0;
    people.set(line.employeeId, person);
  }
  const months = await fundMonthsOf(yearRuns);
  return {
    year,
    yearLabel: financialYearLabel(year),
    months,
    employees: [...people.values()].filter((person) => person.providentFund + person.gratuity > 0).sort((first, second) => first.employeeCode.localeCompare(second.employeeCode)),
    totals: {
      collected: sum(months.map((month) => month.total)),
      deposited: sum(months.map((month) => month.paid)),
      toDeposit: sum(months.map((month) => month.outstanding)),
      gratuity: sum(months.map((month) => month.gratuity)),
    },
  };
}

/** Deposits a month's fund: a draft payment voucher clearing what the fund is owed (2400), which someone else approves. */
export async function depositProvidentFund(actor: Actor, month: string, request: { paymentDate: string; moneyAccountId: string; reference?: string }) {
  const run = await PayrollRun.findOne({ status: 'recorded', month }).lean();
  if (!run) throw new ApiError(404, 'unknown_fund_month', `${monthLabel(month)} has no recorded payroll run.`);
  const [fundMonth] = await fundMonthsOf([run]);
  const label = `PF ${monthLabel(month)}`;
  if (!fundMonth || fundMonth.total === 0) throw new ApiError(409, 'nothing_owed', `${monthLabel(month)} has no provident fund to deposit.`);
  const settled = (await sumSettledAmounts([fundDocumentId(month)])).get(fundDocumentId(month));
  const amount = fundMonth.total - (settled?.committed ?? 0);
  if (amount <= 0) throw new ApiError(409, 'nothing_owed', `${label} is deposited, or a deposit is waiting for approval.`);
  assertWithinOpenAmount(amount, fundMonth.total, settled, label);
  return createLinkedVoucher(actor, 'payment', {
    voucherDate: request.paymentDate,
    memo: `Provident fund deposit, ${monthLabel(month)}`,
    party: 'Provident fund',
    ...(request.reference && { reference: request.reference }),
    moneyAccountId: request.moneyAccountId,
    lines: [
      { accountId: POSTING_ACCOUNTS.providentFundPayable, debit: amount, memo: label },
      { accountId: request.moneyAccountId, credit: amount, memo: 'Deposited' },
    ],
    linkedDocument: { type: 'providentFund', id: fundDocumentId(month), number: label, amount, amountDue: fundMonth.total },
  });
}
