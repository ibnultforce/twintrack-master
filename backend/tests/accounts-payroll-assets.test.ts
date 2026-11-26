import type { Application } from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { runInTransaction } from '../src/db.js';
import { depreciationForMonth, depreciationSchedule } from '../src/modules/accounts/fixedAsset/depreciation.js';
import { getTrialBalance } from '../src/modules/accounts/ledger/ledger.service.js';
import { validateChartOfAccountsFile } from '../src/modules/accounts/ledgerAccount/chartOfAccountsFile.js';
import { insertMissingLedgerAccounts } from '../src/modules/accounts/ledgerAccount/ledgerAccount.repository.js';
import { AccountsEmployee } from '../src/modules/accounts/models/accountsEmployee.js';
import { InventoryMovement } from '../src/modules/accounts/models/inventoryItem.js';
import { grossForMonth } from '../src/modules/accounts/payroll/payroll.service.js';
import { AccessProfile } from '../src/modules/master/models/accessProfile.js';
import { useTestDatabase } from './helpers/database.js';
import { addPerson, importSeedManifests, requestsAs, signIn } from './helpers/signedIn.js';
import { readSeedFiles } from './helpers/testAccess.js';
import { createTestConfig } from './helpers/testConfig.js';

const PAYROLL = '/accounts/payroll-runs';
const ASSETS = '/accounts/fixed-assets';
const INVENTORY = '/accounts/inventory-items';
const VOUCHERS = '/accounts/journal-vouchers';

const SALARY_EXPENSE = 'la_5100';
const SALARIES_PAYABLE = 'la_2200';
const ACCUMULATED_DEPRECIATION = 'la_1650';
const DEPRECIATION = 'la_5600';
const OPENING_EQUITY = 'la_3900';

describe('payroll, fixed assets and inventory', () => {
  useTestDatabase();

  let app: Application;
  let bankId: string;
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
        _id: 'ap_pa_accountant',
        name: 'Accountant',
        grants: {
          accounts: {
            payrollRun: { actions: ['read', 'create', 'update'], fieldAccess: { lines: 'edit' } },
            fixedAsset: { actions: ['read', 'create', 'update'] },
            inventoryItem: { actions: ['read', 'create', 'update'] },
            journalVoucher: { actions: ['read', 'create', 'update'] },
          },
        },
      },
      {
        _id: 'ap_pa_manager',
        name: 'Finance manager',
        grants: { accounts: { payrollRun: { actions: ['read', 'approve'] }, journalVoucher: { actions: ['read', 'approve'] }, fixedAsset: { actions: ['read'] } } },
      },
      { _id: 'ap_pa_reader', name: 'Reader', grants: { accounts: { journalVoucher: { actions: ['read'] } } } },
      { _id: 'ap_pa_books', name: 'Books reader', grants: { accounts: { ledgerAccount: { actions: ['read'] }, payrollRun: { actions: ['read'] } } } },
    ]);
    await addPerson('farhana', { superAdmin: true });
    await addPerson('rahim', { profileId: 'ap_pa_accountant' });
    await addPerson('nadia', { profileId: 'ap_pa_manager' });
    await addPerson('rumana', { profileId: 'ap_pa_reader' });
    await addPerson('rita', { profileId: 'ap_pa_books' });

    const employee = (code: string, salary: number, joinDate: string, isActive = true) => ({
      _id: `emp_${code}`, employeeCode: code, name: `Person ${code}`, designation: 'Engineer', department: 'engineering', joinDate, monthlySalary: salary, isActive, version: 0,
    });
    await AccountsEmployee.create([
      employee('E1', 8_500_000, '2024-01-01'),
      employee('E2', 12_000_000, '2023-06-01'),
      // Joined on 16 November: 15 of 30 days.
      employee('E3', 6_000_000, '2026-11-16'),
      employee('E4', 9_000_000, '2022-01-01', false),
      employee('E5', 7_000_000, '2026-12-01'),
    ]);

    const farhana = await as('farhana');
    const bank = await farhana.post('/accounts/ledger-accounts', { code: '1210', name: 'City Bank, current', type: 'asset', parentId: 'la_1200', cashOrBank: 'bank', bankName: 'City Bank' });
    bankId = bank.body.id as string;
    const opening = await farhana.post(VOUCHERS, { voucherDate: '2026-11-01', memo: 'Opening', lines: [{ accountId: bankId, debit: 100_000_000 }, { accountId: OPENING_EQUITY, credit: 100_000_000 }] });
    await farhana.post(`${VOUCHERS}/${opening.body.id}/submit`);
    await (await as('nadia')).post(`${VOUCHERS}/${opening.body.id}/approve`);
  });

  const balanceOf = async (accountId: string) => (await getTrialBalance()).rows.find((row) => row.accountId === accountId)?.balance ?? 0;

  async function recordVoucher(voucherId: string) {
    expect((await (await as('rahim')).post(`${VOUCHERS}/${voucherId}/submit`)).status).toBe(200);
    expect((await (await as('nadia')).post(`${VOUCHERS}/${voucherId}/approve`)).status).toBe(200);
  }

  describe('who can reach each route', () => {
    const routes: [string, 'get' | 'post' | 'patch', string][] = [
      ['payroll runs', 'get', PAYROLL], ['new run', 'post', PAYROLL], ['run', 'get', `${PAYROLL}/pr_1`], ['edit run', 'patch', `${PAYROLL}/pr_1`],
      ['submit run', 'post', `${PAYROLL}/pr_1/submit`], ['approve run', 'post', `${PAYROLL}/pr_1/approve`], ['return run', 'post', `${PAYROLL}/pr_1/return`],
      ['cancel run', 'post', `${PAYROLL}/pr_1/cancel`], ['run history', 'get', `${PAYROLL}/pr_1/history`],
      ['assets', 'get', ASSETS], ['new asset', 'post', ASSETS], ['asset', 'get', `${ASSETS}/fa_1`], ['edit asset', 'patch', `${ASSETS}/fa_1`], ['asset history', 'get', `${ASSETS}/fa_1/history`],
      ['depreciation preview', 'get', `${ASSETS}/depreciation`], ['depreciation run', 'post', `${ASSETS}/depreciation`],
      ['inventory', 'get', INVENTORY], ['new item', 'post', INVENTORY], ['item', 'get', `${INVENTORY}/ii_1`], ['edit item', 'patch', `${INVENTORY}/ii_1`], ['movement', 'post', `${INVENTORY}/ii_1/movements`],
    ];
    it.each(routes)('%s needs a session', async (_name, method, path) => {
      expect((await request(app)[method](path).send({})).status).toBe(401);
    });
    it.each(routes)('%s needs its permission', async (_name, method, path) => {
      expect((await (await as('rumana'))[method](path, {})).status).toBe(403);
    });
  });

  describe('payroll', () => {
    it('pays a part month for someone who joined during it, and nobody before they join', () => {
      expect(grossForMonth({ monthlySalary: 6_000_000, joinDate: '2026-11-16' }, '2026-11')).toBe(3_000_000);
      expect(grossForMonth({ monthlySalary: 6_000_000, joinDate: '2026-11-01' }, '2026-11')).toBe(6_000_000);
      expect(grossForMonth({ monthlySalary: 6_000_001, joinDate: '2026-11-30' }, '2026-11')).toBe(200_000);
      expect(grossForMonth({ monthlySalary: 7_000_000, joinDate: '2026-12-01' }, '2026-11')).toBe(0);
    });

    it('the Day 3 gate: a run is recorded per person and paid from the bank, balanced, and its maker cannot approve it', async () => {
      const rahim = await as('rahim');
      const created = await rahim.post(PAYROLL, { month: '2026-11', payDate: '2099-11-30' });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ number: 'PR-0001', headcount: 3, total: 23_500_000, status: 'draft' });
      expect(created.body.lines.map((line: { employeeCode: string; gross: number }) => [line.employeeCode, line.gross])).toEqual([['E1', 8_500_000], ['E2', 12_000_000], ['E3', 3_000_000]]);
      expect((await rahim.post(PAYROLL, { month: '2026-11', payDate: '2026-11-30' })).body.error.code).toBe('payroll_month_taken');

      await rahim.post(`${PAYROLL}/${created.body.id}/submit`);
      expect((await rahim.post(`${PAYROLL}/${created.body.id}/approve`)).status).toBe(403);
      const recorded = await (await as('nadia')).post(`${PAYROLL}/${created.body.id}/approve`);
      expect(recorded.body).toMatchObject({ status: 'recorded', paymentStatus: 'unpaid', outstanding: 23_500_000 });
      expect(await balanceOf(SALARY_EXPENSE)).toBe(23_500_000);
      expect(await balanceOf(SALARIES_PAYABLE)).toBe(-23_500_000);

      const payment = await rahim.post(`${PAYROLL}/${created.body.id}/pay`, { paymentDate: '2026-11-30', moneyAccountId: bankId, reference: 'Salary batch 11' });
      expect(payment.body).toMatchObject({ voucherType: 'payment', total: 23_500_000, linkedDocument: { type: 'payrollRun', number: 'PR-0001' } });
      await recordVoucher(payment.body.id);
      expect((await rahim.get(`${PAYROLL}/${created.body.id}`)).body).toMatchObject({ paymentStatus: 'paid', outstanding: 0 });
      expect(await balanceOf(SALARIES_PAYABLE)).toBe(0);
      expect(await balanceOf(bankId)).toBe(100_000_000 - 23_500_000);
      expect((await getTrialBalance()).difference).toBe(0);
    });

    it('hides salaries from a profile without the lines field, and lets nobody change them without it', async () => {
      await (await as('rahim')).post(PAYROLL, { month: '2026-11', payDate: '2026-11-30' });
      const seen = await (await as('nadia')).get(PAYROLL);
      expect(seen.body.runs[0]).not.toHaveProperty('lines');
      expect(seen.body.runs[0].total).toBe(23_500_000);
      const history = await (await as('nadia')).get(`${PAYROLL}/${seen.body.runs[0].id}/history`);
      expect(JSON.stringify(history.body)).not.toContain('8500000');
    });

    it('shows each person\'s salary in the general ledger only to a profile that may see salaries', async () => {
      const rahim = await as('rahim');
      const run = await rahim.post(PAYROLL, { month: '2026-11', payDate: '2026-11-30' });
      await rahim.post(`${PAYROLL}/${run.body.id}/submit`);
      expect((await (await as('nadia')).post(`${PAYROLL}/${run.body.id}/approve`)).status).toBe(200);
      const ledgerPath = `/accounts/general-ledger?accountId=${SALARY_EXPENSE}&from=2026-11-01&to=2026-11-30`;

      const full = await (await as('farhana')).get(ledgerPath);
      expect(full.body).toMatchObject({ payPerPersonHidden: false, total: 3, closing: 23_500_000 });
      expect(full.body.lines.map((line: { memo: string; debit: number }) => [line.memo, line.debit])).toEqual([['E1 Person E1', 8_500_000], ['E2 Person E2', 12_000_000], ['E3 Person E3', 3_000_000]]);

      const hidden = await (await as('rita')).get(ledgerPath);
      expect(hidden.status).toBe(200);
      expect(hidden.body).toMatchObject({ payPerPersonHidden: true, total: 1, closing: 23_500_000 });
      expect(hidden.body.lines).toEqual([expect.objectContaining({ memo: 'PR-0001 salaries, November 2026', debit: 23_500_000, credit: 0, balance: 23_500_000 })]);
      expect(JSON.stringify(hidden.body)).not.toMatch(/8500000|Person E1/);
    });

    it('adjusts a draft with a reason, and takes someone off with a gross of zero', async () => {
      const rahim = await as('rahim');
      const created = await rahim.post(PAYROLL, { month: '2026-11', payDate: '2026-11-30' });
      expect((await rahim.patch(`${PAYROLL}/${created.body.id}`, { adjustments: [{ employeeId: 'emp_E1', gross: 8_000_000 }] })).status).toBe(422);
      const edited = await rahim.patch(`${PAYROLL}/${created.body.id}`, { adjustments: [{ employeeId: 'emp_E1', gross: 8_000_000, note: '2 unpaid days' }, { employeeId: 'emp_E3', gross: 0 }], reason: 'Unpaid leave, and E3 starts next month' });
      expect(edited.body).toMatchObject({ total: 20_000_000, headcount: 2 });
      expect((await rahim.patch(`${PAYROLL}/${created.body.id}`, { adjustments: [{ employeeId: 'emp_E4', gross: 1 }], reason: 'x' })).status).toBe(422);
    });

    it('cancels a recorded run with a reversal, freeing the month', async () => {
      const created = await (await as('rahim')).post(PAYROLL, { month: '2026-11', payDate: '2026-11-30' });
      await (await as('rahim')).post(`${PAYROLL}/${created.body.id}/submit`);
      await (await as('nadia')).post(`${PAYROLL}/${created.body.id}/approve`);
      expect((await (await as('nadia')).post(`${PAYROLL}/${created.body.id}/cancel`, { reason: 'Wrong month' })).body.status).toBe('cancelled');
      expect(await balanceOf(SALARY_EXPENSE)).toBe(0);
      expect((await (await as('rahim')).post(PAYROLL, { month: '2026-11', payDate: '2026-11-30' })).status).toBe(201);
    });

    it('shows a waiting run in the Approvals queue', async () => {
      const created = await (await as('rahim')).post(PAYROLL, { month: '2026-11', payDate: '2026-11-30' });
      await (await as('rahim')).post(`${PAYROLL}/${created.body.id}/submit`);
      const queue = await (await as('nadia')).get('/accounts/approvals');
      expect(queue.body.waitingForYou.items).toEqual([expect.objectContaining({ type: 'payrollRun', number: 'PR-0001', amount: 23_500_000 })]);
    });
  });

  describe('fixed assets and depreciation', () => {
    const laptop = { name: 'Laptop, 16 GB', assetTag: 'TT-LAP-014', category: 'computers', purchaseDate: '2026-11-03', cost: 16_000_000, salvageValue: 1_000_001, usefulLifeMonths: 36 };

    it('spreads cost less salvage over the life, the last month taking the rounding', () => {
      const schedule = depreciationSchedule(laptop);
      expect(schedule).toHaveLength(36);
      expect(schedule[0]).toEqual({ month: '2026-11', amount: 416_666 });
      expect(schedule[35]?.month).toBe('2029-10');
      expect(schedule.reduce((sum, row) => sum + row.amount, 0)).toBe(16_000_000 - 1_000_001);
      expect(depreciationForMonth(laptop, '2026-10')).toBe(0);
      expect(depreciationForMonth(laptop, '2029-11')).toBe(0);
    });

    it('runs a month once, records it on approval, and reads the book value back from the ledger', async () => {
      const rahim = await as('rahim');
      const asset = await rahim.post(ASSETS, laptop);
      expect(asset.status).toBe(201);
      expect(asset.body).toMatchObject({ number: 'FA-0001', monthlyDepreciation: 416_666, accumulatedDepreciation: 0, bookValue: 16_000_000 });

      const preview = await rahim.get(`${ASSETS}/depreciation?month=2026-11`);
      expect(preview.body).toMatchObject({ total: 416_666, lines: [expect.objectContaining({ number: 'FA-0001', amount: 416_666 })] });
      const run = await rahim.post(`${ASSETS}/depreciation`, { month: '2026-11' });
      expect(run.status).toBe(201);
      expect(run.body).toMatchObject({ voucherType: 'journal', voucherDate: '2026-11-30', total: 416_666, linkedDocument: { type: 'depreciation', number: 'DEP 2026-11' } });
      expect((await rahim.post(`${ASSETS}/depreciation`, { month: '2026-11' })).body.error.code).toBe('depreciation_month_taken');
      expect((await rahim.patch(`${VOUCHERS}/${run.body.id}`, { memo: 'x', reason: 'Typo' })).body.error.code).toBe('linked_voucher');

      await recordVoucher(run.body.id);
      expect(await balanceOf(DEPRECIATION)).toBe(416_666);
      expect(await balanceOf(ACCUMULATED_DEPRECIATION)).toBe(-416_666);
      const after = await rahim.get(`${ASSETS}/${asset.body.id}`);
      expect(after.body).toMatchObject({ accumulatedDepreciation: 416_666, bookValue: 16_000_000 - 416_666 });
      expect(after.body.schedule[0]).toMatchObject({ month: '2026-11', voucher: { status: 'recorded' } });
      expect((await rahim.patch(`${ASSETS}/${asset.body.id}`, { cost: 1 })).body.error.code).toBe('asset_depreciated');
      expect((await rahim.patch(`${ASSETS}/${asset.body.id}`, { assetTag: 'TT-LAP-015' })).status).toBe(200);

      // Reversing the run frees the month to be run again.
      expect((await (await as('nadia')).post(`${VOUCHERS}/${run.body.id}/reverse`, {})).status).toBe(200);
      expect((await rahim.get(`${ASSETS}/${asset.body.id}`)).body.accumulatedDepreciation).toBe(0);
      expect((await rahim.post(`${ASSETS}/depreciation`, { month: '2026-11' })).status).toBe(201);
      expect((await getTrialBalance()).difference).toBe(0);
    });

    it('refuses a salvage value above the cost, a month with nothing to depreciate, and a run without voucher access', async () => {
      const rahim = await as('rahim');
      expect((await rahim.post(ASSETS, { ...laptop, salvageValue: 17_000_000 })).status).toBe(422);
      expect((await rahim.post(`${ASSETS}/depreciation`, { month: '2026-11' })).body.error.code).toBe('nothing_to_depreciate');
      await rahim.post(ASSETS, laptop);
      await AccessProfile.updateOne({ _id: 'ap_pa_manager' }, { $set: { 'grants.accounts.fixedAsset.actions': ['read', 'update'] } });
      expect((await (await as('nadia')).post(`${ASSETS}/depreciation`, { month: '2026-11' })).status).toBe(403);
    });
  });

  describe('inventory', () => {
    it('works out stock on hand from movements, never below zero, and flags low stock', async () => {
      const rahim = await as('rahim');
      const item = await rahim.post(INVENTORY, { name: 'Printer toner', assetTag: 'TT-INV-0042', category: 'Office supplies', unit: 'boxes', reorderLevel: 2 });
      expect(item.status).toBe(201);
      expect(item.body).toMatchObject({ onHand: 0, isLow: true });

      expect((await rahim.post(`${INVENTORY}/${item.body.id}/movements`, { date: '2026-11-03', kind: 'in', quantity: 10, reference: 'B-0002' })).body).toMatchObject({ onHand: 10, isLow: false });
      expect((await rahim.post(`${INVENTORY}/${item.body.id}/movements`, { date: '2026-11-10', kind: 'out', quantity: 7.5, note: 'Issued to design' })).body.onHand).toBe(2.5);
      const tooMany = await rahim.post(`${INVENTORY}/${item.body.id}/movements`, { date: '2026-11-11', kind: 'out', quantity: 3 });
      expect(tooMany.body.error.code).toBe('not_enough_stock');
      const counted = await rahim.post(`${INVENTORY}/${item.body.id}/movements`, { date: '2026-11-30', kind: 'adjust', quantity: -0.5, note: 'Count' });
      expect(counted.body).toMatchObject({ onHand: 2, isLow: true });
      expect(counted.body.movements).toHaveLength(3);
      expect((await rahim.post(`${INVENTORY}/${item.body.id}/movements`, { date: '2026-11-30', kind: 'in', quantity: 0.0001 })).status).toBe(422);
      expect((await rahim.post(`${INVENTORY}/${item.body.id}/movements`, { date: '2026-11-30', kind: 'out', quantity: -1 })).status).toBe(422);
    });

    it('refuses movements on an inactive item, and keeps every movement', async () => {
      const rahim = await as('rahim');
      const item = await rahim.post(INVENTORY, { name: 'Chairs', category: 'Furniture', unit: 'pcs' });
      await rahim.post(`${INVENTORY}/${item.body.id}/movements`, { date: '2026-11-03', kind: 'in', quantity: 4 });
      await rahim.patch(`${INVENTORY}/${item.body.id}`, { isActive: false });
      expect((await rahim.post(`${INVENTORY}/${item.body.id}/movements`, { date: '2026-11-04', kind: 'out', quantity: 1 })).body.error.code).toBe('inventory_item_inactive');
      expect(await InventoryMovement.countDocuments({ itemId: item.body.id })).toBe(1);
      expect((await rahim.get(`${INVENTORY}?search=chai`)).body.items[0]).toMatchObject({ onHand: 4, isActive: false });
    });
  });
});
