import type { Application } from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { runInTransaction } from '../src/db.js';
import { repaymentSchedule } from '../src/modules/accounts/employeeLoan/loanRepayments.js';
import { getTrialBalance } from '../src/modules/accounts/ledger/ledger.service.js';
import { validateChartOfAccountsFile } from '../src/modules/accounts/ledgerAccount/chartOfAccountsFile.js';
import { insertMissingLedgerAccounts } from '../src/modules/accounts/ledgerAccount/ledgerAccount.repository.js';
import { AccountsEmployee } from '../src/modules/accounts/models/accountsEmployee.js';
import { leaveDeductionFor } from '../src/modules/accounts/payroll/payroll.service.js';
import { AccessProfile } from '../src/modules/master/models/accessProfile.js';
import { useTestDatabase } from './helpers/database.js';
import { addPerson, importSeedManifests, requestsAs, signIn } from './helpers/signedIn.js';
import { readSeedFiles } from './helpers/testAccess.js';
import { createTestConfig } from './helpers/testConfig.js';

const LOANS = '/accounts/employee-loans';
const PAYROLL = '/accounts/payroll-runs';
const VOUCHERS = '/accounts/journal-vouchers';
const LEAVE = '/accounts/unpaid-leave';
const EMPLOYEE_LOANS = 'la_1400';
const SALARIES_PAYABLE = 'la_2200';
const SALARY_EXPENSE = 'la_5100';
const CASH = 'la_1100';
const OPENING = 'la_3900';

describe('loans and advances repaid through payroll, and unpaid leave', () => {
  useTestDatabase();

  let app: Application;
  const as = async (id: string) => requestsAs(app, await signIn(app, `${id}@twintrack.test`));

  beforeAll(() => {
    app = createApp(createTestConfig());
  });

  beforeEach(async () => {
    await importSeedManifests();
    const chart = validateChartOfAccountsFile(readSeedFiles().chartOfAccounts);
    if (!chart.ok) throw new Error(JSON.stringify(chart.errors));
    await runInTransaction((session) => insertMissingLedgerAccounts(chart.value, session));
    await AccessProfile.create([
      {
        _id: 'ap_ll_accountant',
        name: 'Accountant',
        grants: { accounts: { employeeLoan: { actions: ['read', 'create', 'update'] }, unpaidLeave: { actions: ['read', 'update'] }, payrollRun: { actions: ['read', 'create', 'update'], fieldAccess: { lines: 'edit' } }, journalVoucher: { actions: ['read', 'create', 'update'] } } },
      },
      { _id: 'ap_ll_manager', name: 'Manager', grants: { accounts: { employeeLoan: { actions: ['read', 'approve'] }, payrollRun: { actions: ['read', 'approve'] }, journalVoucher: { actions: ['read', 'approve'] } } } },
      { _id: 'ap_ll_none', name: 'Vouchers only', grants: { accounts: { journalVoucher: { actions: ['read'] } } } },
    ]);
    await addPerson('farhana', { superAdmin: true });
    await addPerson('rahim', { profileId: 'ap_ll_accountant' });
    await addPerson('nadia', { profileId: 'ap_ll_manager' });
    await addPerson('rumana', { profileId: 'ap_ll_none' });
    await AccountsEmployee.create([
      { _id: 'emp_1', employeeCode: 'E1', name: 'Nusrat Jahan', designation: 'QA Engineer', department: 'engineering', joinDate: '2024-01-01', monthlySalary: 6_000_000, isActive: true, version: 0 },
      { _id: 'emp_2', employeeCode: 'E2', name: 'Farhana Akter', designation: 'Analyst', department: 'delivery', joinDate: '2024-01-01', monthlySalary: 8_000_000, isActive: true, version: 0 },
    ]);
    const farhana = await as('farhana');
    const opening = await farhana.post(VOUCHERS, { voucherDate: '2026-09-01', memo: 'Opening cash', lines: [{ accountId: CASH, debit: 100_000_000 }, { accountId: OPENING, credit: 100_000_000 }] });
    await farhana.post(`${VOUCHERS}/${opening.body.id}/submit`);
    await (await as('nadia')).post(`${VOUCHERS}/${opening.body.id}/approve`);
  });

  const balanceOf = async (accountId: string) => (await getTrialBalance()).rows.find((row) => row.accountId === accountId)?.balance ?? 0;

  async function recordVoucher(voucherId: string) {
    await (await as('rahim')).post(`${VOUCHERS}/${voucherId}/submit`);
    expect((await (await as('nadia')).post(`${VOUCHERS}/${voucherId}/approve`)).status).toBe(200);
  }

  /** Makes, approves and pays a month's payroll. Returns the recorded run, with its lines. */
  async function runPayroll(month: string) {
    const rahim = await as('rahim');
    const created = await rahim.post(PAYROLL, { month, payDate: `${month}-28` });
    expect(created.status).toBe(201);
    await rahim.post(`${PAYROLL}/${created.body.id}/submit`);
    const recorded = await (await as('nadia')).post(`${PAYROLL}/${created.body.id}/approve`);
    expect(recorded.status).toBe(200);
    const payment = await rahim.post(`${PAYROLL}/${created.body.id}/pay`, { paymentDate: `${month}-28`, moneyAccountId: CASH });
    await recordVoucher(payment.body.id);
    // Read back as the accountant: the approver's profile hides salaries, so her answer has no lines.
    return (await rahim.get(`${PAYROLL}/${created.body.id}`)).body;
  }

  it('needs a session and the permission', async () => {
    for (const [method, path] of [['get', LOANS], ['post', LOANS], ['get', `${LOANS}/ln_1`], ['post', `${LOANS}/ln_1/submit`], ['post', `${LOANS}/ln_1/approve`], ['post', `${LOANS}/ln_1/return`], ['post', `${LOANS}/ln_1/cancel`], ['get', `${LOANS}/ln_1/history`], ['get', `${LEAVE}?month=2026-11`], ['put', `${LEAVE}/emp_1/2026-11`]] as const) {
      expect((await request(app)[method](path).send({})).status).toBe(401);
      expect((await (await as('rumana'))[method](path, {})).status).toBe(403);
    }
  });

  it('plans the repayments, the last month taking what is left', () => {
    expect(repaymentSchedule({ amount: 6_000_000, monthlyInstallment: 2_500_000, firstRepaymentMonth: '2026-11' })).toEqual([
      { month: '2026-11', amount: 2_500_000 }, { month: '2026-12', amount: 2_500_000 }, { month: '2027-01', amount: 1_000_000 },
    ]);
    expect(leaveDeductionFor(8_000_000, 2, 8_000_000)).toBe(533_333);
    expect(leaveDeductionFor(8_000_000, 0.5, 8_000_000)).toBe(133_333);
    expect(leaveDeductionFor(1_000, 31, 1_000)).toBe(1_000);
  });

  it('the Day 5 test: a loan balance falls with each payroll, matching its schedule, and the books agree', async () => {
    const rahim = await as('rahim');
    const loan = await rahim.post(LOANS, { employeeId: 'emp_1', kind: 'advance', purpose: 'Salary advance', issueDate: '2026-10-05', amount: 6_000_000, monthlyInstallment: 2_500_000, firstRepaymentMonth: '2026-11' });
    expect(loan.status).toBe(201);
    expect(loan.body).toMatchObject({ number: 'LN-0001', lastRepaymentMonth: '2027-01', outstanding: 0 });
    await rahim.post(`${LOANS}/${loan.body.id}/submit`);
    expect((await rahim.post(`${LOANS}/${loan.body.id}/approve`)).status).toBe(403);
    const approved = await (await as('nadia')).post(`${LOANS}/${loan.body.id}/approve`);
    expect(approved.body).toMatchObject({ status: 'recorded', outstanding: 6_000_000 });
    expect(await balanceOf(EMPLOYEE_LOANS)).toBe(6_000_000);

    const payout = await rahim.post(`${LOANS}/${loan.body.id}/pay`, { paymentDate: '2026-10-05', moneyAccountId: CASH });
    await recordVoucher(payout.body.id);
    expect((await rahim.get(`${LOANS}/${loan.body.id}`)).body.payout.paymentStatus).toBe('paid');

    // October's payroll is before repayments start.
    const october = await runPayroll('2026-10');
    expect(october.lines.find((line: { employeeId: string }) => line.employeeId === 'emp_1').loanRepayments).toBeUndefined();

    const expected = [['2026-11', 3_500_000], ['2026-12', 1_000_000], ['2027-01', 0]] as const;
    for (const [month, outstanding] of expected) {
      const run = await runPayroll(month);
      const line = run.lines.find((candidate: { employeeId: string }) => candidate.employeeId === 'emp_1');
      expect(line.net).toBe(6_000_000 - line.loanRepayments[0].amount);
      const after = await rahim.get(`${LOANS}/${loan.body.id}`);
      expect(after.body.outstanding).toBe(outstanding);
      expect(await balanceOf(EMPLOYEE_LOANS)).toBe(outstanding);
    }
    const finished = await rahim.get(`${LOANS}/${loan.body.id}`);
    expect(finished.body.schedule.map((row: { amount: number; taken?: { amount: number } }) => [row.amount, row.taken?.amount])).toEqual([[2_500_000, 2_500_000], [2_500_000, 2_500_000], [1_000_000, 1_000_000]]);
    // Repaid: February takes nothing.
    const february = await runPayroll('2027-02');
    expect(february.lines.find((line: { employeeId: string }) => line.employeeId === 'emp_1').loanRepayments).toBeUndefined();
    expect(await balanceOf(SALARIES_PAYABLE)).toBe(0);
    expect((await getTrialBalance()).difference).toBe(0);
  });

  it('takes unpaid leave off the gross, refused once the month has a run', async () => {
    const rahim = await as('rahim');
    const set = await rahim.put(`${LEAVE}/emp_2/2026-11`, { days: 2, note: '4 and 5 November' });
    expect(set.status).toBe(200);
    expect(set.body.employees.find((row: { employeeId: string }) => row.employeeId === 'emp_2')).toMatchObject({ days: 2, dailyRate: 266_667, deduction: 533_333 });
    expect((await rahim.put(`${LEAVE}/emp_2/2026-11`, { days: 0.3 })).status).toBe(422);

    const run = await rahim.post(PAYROLL, { month: '2026-11', payDate: '2026-11-28' });
    const line = run.body.lines.find((candidate: { employeeId: string }) => candidate.employeeId === 'emp_2');
    expect(line).toMatchObject({ gross: 8_000_000 - 533_333, unpaidLeaveDays: 2, leaveDeduction: 533_333, net: 8_000_000 - 533_333 });
    expect(line.note).toContain('2 unpaid leave days');
    expect((await rahim.put(`${LEAVE}/emp_2/2026-11`, { days: 1 })).body.error.code).toBe('payroll_run_exists');

    await rahim.post(`${PAYROLL}/${run.body.id}/submit`);
    await (await as('nadia')).post(`${PAYROLL}/${run.body.id}/approve`);
    expect(await balanceOf(SALARY_EXPENSE)).toBe(6_000_000 + 8_000_000 - 533_333);
  });

  it('takes no repayment for a loan approved but not yet paid out', async () => {
    const rahim = await as('rahim');
    const loan = await rahim.post(LOANS, { employeeId: 'emp_1', kind: 'advance', purpose: 'Travel', issueDate: '2026-11-01', amount: 1_000_000, monthlyInstallment: 500_000, firstRepaymentMonth: '2026-11' });
    await rahim.post(`${LOANS}/${loan.body.id}/submit`);
    await (await as('nadia')).post(`${LOANS}/${loan.body.id}/approve`);
    // A draft payout isn't money given yet.
    await rahim.post(`${LOANS}/${loan.body.id}/pay`, { paymentDate: '2026-11-01', moneyAccountId: CASH });
    const run = await rahim.post(PAYROLL, { month: '2026-11', payDate: '2026-11-28' });
    expect(run.body.lines.find((line: { employeeId: string }) => line.employeeId === 'emp_1').loanRepayments).toBeUndefined();
  });

  it('cancels a loan only while nothing is paid out or repaid', async () => {
    const rahim = await as('rahim');
    const loan = await rahim.post(LOANS, { employeeId: 'emp_2', kind: 'loan', purpose: 'Laptop loan', issueDate: '2026-11-01', amount: 1_200_000, monthlyInstallment: 100_000, firstRepaymentMonth: '2026-12' });
    expect((await rahim.post(LOANS, { employeeId: 'emp_2', kind: 'loan', purpose: 'x', issueDate: '2026-11-01', amount: 100, monthlyInstallment: 200, firstRepaymentMonth: '2026-12' })).status).toBe(422);
    await rahim.post(`${LOANS}/${loan.body.id}/submit`);
    await (await as('nadia')).post(`${LOANS}/${loan.body.id}/approve`);
    await rahim.post(`${LOANS}/${loan.body.id}/pay`, { paymentDate: '2026-11-01', moneyAccountId: CASH });
    expect((await (await as('nadia')).post(`${LOANS}/${loan.body.id}/cancel`, { reason: 'x' })).body.error.code).toBe('loan_in_use');
  });
});
