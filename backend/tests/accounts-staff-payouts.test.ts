import type { Application } from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { runInTransaction } from '../src/db.js';
import { getTrialBalance } from '../src/modules/accounts/ledger/ledger.service.js';
import { validateChartOfAccountsFile } from '../src/modules/accounts/ledgerAccount/chartOfAccountsFile.js';
import { insertMissingLedgerAccounts } from '../src/modules/accounts/ledgerAccount/ledgerAccount.repository.js';
import { AccountsEmployee } from '../src/modules/accounts/models/accountsEmployee.js';
import { commissionOn } from '../src/modules/accounts/staffPayout/commissions.js';
import { AccessProfile } from '../src/modules/master/models/accessProfile.js';
import { Client } from '../src/modules/master/models/client.js';
import { IncentiveLedgerEntry } from '../src/modules/projects/models/incentive.js';
import { useTestDatabase } from './helpers/database.js';
import { addPerson, importSeedManifests, requestsAs, signIn } from './helpers/signedIn.js';
import { readSeedFiles } from './helpers/testAccess.js';
import { createTestConfig } from './helpers/testConfig.js';

const PAYOUTS = '/accounts/staff-payouts';
const VOUCHERS = '/accounts/journal-vouchers';
const BONUS = 'la_5200';
const COMMISSION = 'la_5250';
const SALARIES_PAYABLE = 'la_2200';
const CASH = 'la_1100';

describe('bonus, incentive and commission payouts, and employee payments', () => {
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
        _id: 'ap_sp_accountant',
        name: 'Accountant',
        grants: { accounts: { staffPayout: { actions: ['read', 'create', 'update'] }, commissionRule: { actions: ['read', 'create', 'update'] }, journalVoucher: { actions: ['read', 'create', 'update'] }, payrollRun: { actions: ['read'] } } },
      },
      { _id: 'ap_sp_manager', name: 'Manager', grants: { accounts: { staffPayout: { actions: ['read', 'approve'] }, journalVoucher: { actions: ['read', 'approve'] }, invoice: { actions: ['read', 'approve'] } } } },
      { _id: 'ap_sp_none', name: 'Vouchers only', grants: { accounts: { journalVoucher: { actions: ['read'] } } } },
    ]);
    await addPerson('farhana', { superAdmin: true });
    await addPerson('rahim', { profileId: 'ap_sp_accountant' });
    await addPerson('nadia', { profileId: 'ap_sp_manager' });
    await addPerson('rumana', { profileId: 'ap_sp_none' });
    await addPerson('tanvir');
    await addPerson('salma');
    await AccountsEmployee.create([
      { _id: 'emp_1', employeeCode: 'E1', name: 'Rubel Ahmed', designation: 'Sales', department: 'sales', joinDate: '2024-01-01', monthlySalary: 6_000_000, isActive: true, version: 0 },
      { _id: 'emp_2', employeeCode: 'E2', name: 'Nusrat Jahan', designation: 'Engineer', department: 'engineering', joinDate: '2024-01-01', monthlySalary: 9_000_000, isActive: true, version: 0 },
    ]);
    await IncentiveLedgerEntry.create([
      { _id: 'il_1', userId: 'tanvir', month: 11, year: 2026, completedHours: 40, hourlyRate: 250, totalPayout: 10_000.5, disbursed: false },
      { _id: 'il_2', userId: 'salma', month: 11, year: 2026, completedHours: 12, hourlyRate: 250, totalPayout: 3_000, disbursed: false },
      { _id: 'il_3', userId: 'tanvir', month: 10, year: 2026, completedHours: 10, hourlyRate: 250, totalPayout: 2_500, disbursed: true },
    ]);
  });

  const balanceOf = async (accountId: string) => (await getTrialBalance()).rows.find((row) => row.accountId === accountId)?.balance ?? 0;

  async function submitAndApprove(payoutId: string) {
    expect((await (await as('rahim')).post(`${PAYOUTS}/${payoutId}/submit`)).status).toBe(200);
    const approved = await (await as('nadia')).post(`${PAYOUTS}/${payoutId}/approve`);
    return approved;
  }

  it('needs a session and the permission', async () => {
    for (const [method, path] of [['get', PAYOUTS], ['post', PAYOUTS], ['get', `${PAYOUTS}/sp_1`], ['post', `${PAYOUTS}/sp_1/submit`], ['post', `${PAYOUTS}/sp_1/approve`], ['post', `${PAYOUTS}/sp_1/return`], ['post', `${PAYOUTS}/sp_1/cancel`], ['get', `${PAYOUTS}/sp_1/history`], ['get', '/accounts/commission-rules'], ['post', '/accounts/commission-rules'], ['patch', '/accounts/commission-rules/cr_1'], ['get', '/accounts/employee-payments']] as const) {
      expect((await request(app)[method](path).send({})).status).toBe(401);
      expect((await (await as('rumana'))[method](path, {})).status).toBe(403);
    }
  });

  it('the Day 4 gate: a month of incentives is recorded and marked paid in Project management, and can be paid only once', async () => {
    const rahim = await as('rahim');
    const created = await rahim.post(PAYOUTS, { kind: 'incentive', month: '2026-11', payDate: '2026-11-30' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ number: 'BI-0001', title: 'Incentives, November 2026', total: 1_300_050, headcount: 2 });
    // Already in a live payout: a second one for the month finds nobody.
    expect((await rahim.post(PAYOUTS, { kind: 'incentive', month: '2026-11', payDate: '2026-11-30' })).body.error.code).toBe('nothing_to_pay');
    // October was already paid in Project management.
    expect((await rahim.post(PAYOUTS, { kind: 'incentive', month: '2026-10', payDate: '2026-10-31' })).body.error.code).toBe('nothing_to_pay');

    expect((await rahim.post(`${PAYOUTS}/${created.body.id}/submit`)).status).toBe(200);
    expect((await rahim.post(`${PAYOUTS}/${created.body.id}/approve`)).status).toBe(403);
    // Someone pays Salma's incentive another way before approval: the payout is refused and nothing is recorded.
    await IncentiveLedgerEntry.updateOne({ _id: 'il_2' }, { $set: { disbursed: true } });
    const refused = await (await as('nadia')).post(`${PAYOUTS}/${created.body.id}/approve`);
    expect(refused.body.error.code).toBe('incentive_already_paid');
    expect((await IncentiveLedgerEntry.findById('il_1').lean())?.disbursed).toBe(false);
    expect(await balanceOf(BONUS)).toBe(0);

    await IncentiveLedgerEntry.updateOne({ _id: 'il_2' }, { $set: { disbursed: false } });
    const approved = await (await as('nadia')).post(`${PAYOUTS}/${created.body.id}/approve`);
    expect(approved.body).toMatchObject({ status: 'recorded', paymentStatus: 'unpaid' });
    expect((await IncentiveLedgerEntry.find({ month: 11 }).lean()).every((entry) => entry.disbursed)).toBe(true);
    expect(await balanceOf(BONUS)).toBe(1_300_050);
    expect((await (await as('nadia')).post(`${PAYOUTS}/${created.body.id}/cancel`, { reason: 'x' })).body.error.code).toBe('incentive_payout_recorded');

    // Once recorded, the month's incentives are paid, so a new payout still finds nobody.
    expect((await rahim.post(PAYOUTS, { kind: 'incentive', month: '2026-11', payDate: '2026-11-30' })).body.error.code).toBe('nothing_to_pay');

    const payment = await rahim.post(`${PAYOUTS}/${created.body.id}/pay`, { paymentDate: '2026-11-30', moneyAccountId: CASH });
    expect(payment.body).toMatchObject({ voucherType: 'payment', linkedDocument: { type: 'staffPayout', number: 'BI-0001' } });
    await rahim.post(`${VOUCHERS}/${payment.body.id}/submit`);
    expect((await (await as('nadia')).post(`${VOUCHERS}/${payment.body.id}/approve`)).status).toBe(200);
    expect((await rahim.get(`${PAYOUTS}/${created.body.id}`)).body).toMatchObject({ paymentStatus: 'paid' });
    expect(await balanceOf(SALARIES_PAYABLE)).toBe(0);
    expect((await getTrialBalance()).difference).toBe(0);
  });

  it('records a typed bonus per employee, and a cancelled draft frees nobody twice', async () => {
    const rahim = await as('rahim');
    expect((await rahim.post(PAYOUTS, { kind: 'bonus', title: 'Eid bonus', payDate: '2026-11-15', lines: [{ employeeId: 'emp_1', amount: 1 }, { employeeId: 'emp_1', amount: 1 }] })).status).toBe(422);
    const created = await rahim.post(PAYOUTS, { kind: 'bonus', title: 'Eid bonus', payDate: '2026-11-15', lines: [{ employeeId: 'emp_1', amount: 3_000_000 }, { employeeId: 'emp_2', amount: 4_500_000, note: 'Half of basic' }] });
    expect(created.body).toMatchObject({ kind: 'bonus', total: 7_500_000 });
    expect((await submitAndApprove(created.body.id)).body.status).toBe('recorded');
    expect(await balanceOf(BONUS)).toBe(7_500_000);
    expect((await (await as('nadia')).post(`${PAYOUTS}/${created.body.id}/cancel`, { reason: 'Wrong amounts' })).body.status).toBe('cancelled');
    expect(await balanceOf(BONUS)).toBe(0);
  });

  it('earns commission on money received only, pays each receipt once, and shows it in employee payments', async () => {
    expect(commissionOn(1_250_050, 200)).toBe(25_001);
    await Client.create({ _id: 'cl_hope', name: 'Hope Foundation', status: 'active', version: 0 });
    const rahim = await as('rahim');
    const rule = await rahim.post('/accounts/commission-rules', { employeeId: 'emp_1', clientId: 'cl_hope', rateBasisPoints: 200, startDate: '2026-11-01' });
    expect(rule.status).toBe(201);
    expect((await rahim.post('/accounts/commission-rules', { employeeId: 'emp_1', clientId: 'cl_hope', rateBasisPoints: 300, startDate: '2026-11-01' })).body.error.code).toBe('commission_rule_exists');

    const farhana = await as('farhana');
    const invoice = await farhana.post('/accounts/invoices', { clientId: 'cl_hope', issueDate: '2026-11-05', items: [{ description: 'Work', amount: 5_000_000 }] });
    await farhana.post(`/accounts/invoices/${invoice.body.id}/submit`);
    await (await as('nadia')).post(`/accounts/invoices/${invoice.body.id}/approve`);
    // An invoice alone earns nothing.
    expect((await rahim.get('/accounts/commission-rules')).body.rules[0]).toMatchObject({ earned: 0, unpaid: 0 });
    const receipt = await farhana.post(`/accounts/invoices/${invoice.body.id}/receive-payment`, { receivedDate: '2026-11-20', moneyAccountId: CASH, amount: 1_250_050 });
    await farhana.post(`${VOUCHERS}/${receipt.body.id}/submit`);
    await (await as('nadia')).post(`${VOUCHERS}/${receipt.body.id}/approve`);
    expect((await rahim.get('/accounts/commission-rules')).body.rules[0]).toMatchObject({ received: 1_250_050, earned: 25_001, unpaid: 25_001 });

    const payout = await rahim.post(PAYOUTS, { kind: 'commission', payDate: '2026-11-30' });
    expect(payout.body).toMatchObject({ total: 25_001, lines: [expect.objectContaining({ payeeId: 'emp_1', receiptIds: [receipt.body.id] })] });
    expect((await rahim.get('/accounts/commission-rules')).body.rules[0]).toMatchObject({ inPayouts: 25_001, unpaid: 0 });
    expect((await rahim.post(PAYOUTS, { kind: 'commission', payDate: '2026-11-30' })).body.error.code).toBe('nothing_to_pay');
    await submitAndApprove(payout.body.id);
    expect(await balanceOf(COMMISSION)).toBe(25_001);

    const payments = await rahim.get('/accounts/employee-payments?employeeId=emp_1');
    expect(payments.body.payments).toEqual([expect.objectContaining({ type: 'commission', amount: 25_001, isPaid: false, record: expect.objectContaining({ number: 'BI-0001' }) })]);
    expect(payments.body.maySeeSalaries).toBe(false);
  });
});
