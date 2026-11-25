import type { Application } from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { runInTransaction } from '../src/db.js';
import { validateChartOfAccountsFile } from '../src/modules/accounts/ledgerAccount/chartOfAccountsFile.js';
import { insertMissingLedgerAccounts } from '../src/modules/accounts/ledgerAccount/ledgerAccount.repository.js';
import { AccessProfile } from '../src/modules/master/models/accessProfile.js';
import { useTestDatabase } from './helpers/database.js';
import { addPerson, importSeedManifests, requestsAs, signIn } from './helpers/signedIn.js';
import { readSeedFiles } from './helpers/testAccess.js';
import { createTestConfig } from './helpers/testConfig.js';

const VOUCHERS = '/accounts/journal-vouchers';
const CASH = 'la_1100';
const RECEIVABLE = 'la_1300';
const FIXED_ASSETS = 'la_1600';
const PAYABLE = 'la_2100';
const CAPITAL = 'la_3100';
const OPENING_EQUITY = 'la_3900';
const SERVICE_INCOME = 'la_4100';
const RENT = 'la_5300';
const INTERNET = 'la_5400';
const OFFICE = 'la_5500';

const REPORT_PATHS = [
  '/accounts/reports/profit-and-loss?from=2026-11-01&to=2026-11-30',
  '/accounts/reports/balance-sheet?to=2026-11-30',
  '/accounts/reports/cash-flow?from=2026-11-01&to=2026-11-30',
  '/accounts/dashboard?month=2026-11',
];

const amountsOf = (rows: { code: string; amount: number }[]) => Object.fromEntries(rows.map((row) => [row.code, row.amount]));

describe('reports and the Accounts dashboard', () => {
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
      { _id: 'ap_rp_reader', name: 'Books reader', grants: { accounts: { ledgerAccount: { actions: ['read'] } } } },
      { _id: 'ap_rp_none', name: 'Vouchers only', grants: { accounts: { journalVoucher: { actions: ['read'] } } } },
      { _id: 'ap_rp_approver', name: 'Approver', grants: { accounts: { journalVoucher: { actions: ['read', 'approve'] } } } },
    ]);
    await addPerson('farhana', { superAdmin: true });
    await addPerson('rita', { profileId: 'ap_rp_reader' });
    await addPerson('rumana', { profileId: 'ap_rp_none' });
    await addPerson('nadia', { profileId: 'ap_rp_approver' });
  });

  /** Makes, submits and has nadia approve a voucher, so it posts. Each line is [account, debit, credit]. */
  async function record(voucherDate: string, memo: string, lines: [string, number, number][]) {
    const farhana = await as('farhana');
    const created = await farhana.post(VOUCHERS, { voucherDate, memo, lines: lines.map(([accountId, debit, credit]) => ({ accountId, debit, credit })) });
    expect(created.status).toBe(201);
    await farhana.post(`${VOUCHERS}/${created.body.id}/submit`);
    expect((await (await as('nadia')).post(`${VOUCHERS}/${created.body.id}/approve`)).status).toBe(200);
    return created.body.id as string;
  }

  /**
   * The seeded month, November 2026, with one month on each side of it. The expected figures below are worked out by
   * hand, the way the spreadsheet check does it.
   */
  async function seedNovember() {
    await record('2026-10-15', 'October work', [[RECEIVABLE, 3_000_000, 0], [SERVICE_INCOME, 0, 3_000_000]]);
    await record('2026-10-31', 'Opening cash', [[CASH, 10_000_000, 0], [OPENING_EQUITY, 0, 10_000_000]]);
    await record('2026-11-01', 'Owner puts in capital', [[CASH, 5_000_000, 0], [CAPITAL, 0, 5_000_000]]);
    await record('2026-11-03', 'November work billed', [[RECEIVABLE, 8_000_000, 0], [SERVICE_INCOME, 0, 8_000_000]]);
    await record('2026-11-05', 'November rent', [[RENT, 2_500_000, 0], [CASH, 0, 2_500_000]]);
    await record('2026-11-10', 'Client pays', [[CASH, 6_000_000, 0], [RECEIVABLE, 0, 6_000_000]]);
    await record('2026-11-12', 'Laptop', [[FIXED_ASSETS, 1_200_000, 0], [CASH, 0, 1_200_000]]);
    await record('2026-11-20', 'Internet bill, unpaid', [[INTERNET, 350_000, 0], [PAYABLE, 0, 350_000]]);
    await record('2026-11-25', 'Stationery', [[OFFICE, 12_345, 0], [CASH, 0, 12_345]]);
    await record('2026-12-02', 'December rent', [[RENT, 2_500_000, 0], [CASH, 0, 2_500_000]]);
  }

  it('needs a session and chart read access', async () => {
    for (const path of REPORT_PATHS) {
      expect((await request(app).get(path)).status).toBe(401);
      expect((await (await as('rumana')).get(path)).status).toBe(403);
    }
  });

  it('refuses a missing or reversed period and a bad month', async () => {
    const rita = await as('rita');
    for (const path of [
      '/accounts/reports/profit-and-loss?from=2026-11-30&to=2026-11-01',
      '/accounts/reports/cash-flow?from=2026-11-01',
      '/accounts/reports/balance-sheet?to=2026-02-30',
      '/accounts/dashboard?month=2026-13',
    ]) {
      expect((await rita.get(path)).status).toBe(422);
    }
  });

  it('the Day 5 gate: the seeded month matches the hand-worked figures in all four reports and the dashboard', async () => {
    await seedNovember();
    const rita = await as('rita');

    const profitAndLoss = (await rita.get(REPORT_PATHS[0]!)).body;
    expect(amountsOf(profitAndLoss.income.rows)).toEqual({ '4100': 8_000_000 });
    expect(amountsOf(profitAndLoss.expenses.rows)).toEqual({ '5300': 2_500_000, '5400': 350_000, '5500': 12_345 });
    expect(profitAndLoss).toMatchObject({ income: { total: 8_000_000 }, expenses: { total: 2_862_345 }, netProfit: 5_137_655 });

    const balanceSheet = (await rita.get(REPORT_PATHS[1]!)).body;
    expect(amountsOf(balanceSheet.assets.rows)).toEqual({ '1100': 17_287_655, '1300': 5_000_000, '1600': 1_200_000 });
    expect(amountsOf(balanceSheet.liabilities.rows)).toEqual({ '2100': 350_000 });
    expect(amountsOf(balanceSheet.equity.rows)).toEqual({ '3100': 5_000_000, '3900': 10_000_000 });
    // October's and November's profit, in the same financial year; nothing from earlier years.
    expect(balanceSheet.equity.profitRows).toEqual([{ key: 'yearProfit', label: 'Profit this financial year', amount: 8_137_655 }]);
    expect(balanceSheet).toMatchObject({ financialYear: 2026, assets: { total: 23_487_655 }, totalLiabilitiesAndEquity: 23_487_655, difference: 0 });

    const cashFlow = (await rita.get(REPORT_PATHS[2]!)).body;
    const sections = Object.fromEntries(cashFlow.sections.map((each: { key: string; rows: { code: string; amount: number }[]; total: number }) => [each.key, { rows: amountsOf(each.rows), total: each.total }]));
    expect(sections).toEqual({
      operating: { rows: { '1300': 6_000_000, '5300': -2_500_000, '5500': -12_345 }, total: 3_487_655 },
      investing: { rows: { '1600': -1_200_000 }, total: -1_200_000 },
      financing: { rows: { '3100': 5_000_000 }, total: 5_000_000 },
    });
    expect(cashFlow).toMatchObject({ opening: 10_000_000, netChange: 7_287_655, closing: 17_287_655, difference: 0 });

    const dashboard = (await rita.get(REPORT_PATHS[3]!)).body;
    expect(dashboard).toMatchObject({
      from: '2026-11-01',
      to: '2026-11-30',
      financialYear: 2026,
      cash: { total: 17_287_655 },
      receivable: 5_000_000,
      payable: 350_000,
      thisMonth: { income: 8_000_000, expenses: 2_862_345, profit: 5_137_655 },
      yearToDate: { income: 11_000_000, expenses: 2_862_345, profit: 8_137_655 },
    });
    expect(dashboard.trend.map((each: { month: string; profit: number }) => [each.month, each.profit])).toEqual([
      ['2026-07', 0],
      ['2026-08', 0],
      ['2026-09', 0],
      ['2026-10', 3_000_000],
      ['2026-11', 5_137_655],
    ]);
    expect(dashboard.topExpenses.map((each: { code: string }) => each.code)).toEqual(['5300', '5400', '5500']);

    // Every report agrees with the trial balance at the month end.
    const trial = (await rita.get('/accounts/trial-balance?to=2026-11-30')).body;
    expect(trial.difference).toBe(0);
    const trialCash = trial.rows.find((row: { code: string }) => row.code === '1100').balance;
    expect(trialCash).toBe(balanceSheet.assets.rows.find((row: { code: string }) => row.code === '1100').amount);
  });

  it('a reversed voucher nets out of every report', async () => {
    await seedNovember();
    const stationery = await record('2026-11-26', 'Wrong stationery', [[OFFICE, 99_999, 0], [CASH, 0, 99_999]]);
    // The reversal is dated the day it is made, so read up to a date after any test run.
    expect((await (await as('nadia')).post(`${VOUCHERS}/${stationery}/reverse`, {})).status).toBe(200);
    const rita = await as('rita');
    const decemberRent = 2_500_000;
    expect((await rita.get('/accounts/reports/profit-and-loss?from=2026-11-01&to=2099-12-31')).body.netProfit).toBe(5_137_655 - decemberRent);
    expect((await rita.get('/accounts/reports/cash-flow?from=2026-11-01&to=2099-12-31')).body.closing).toBe(17_287_655 - decemberRent);
    expect((await rita.get('/accounts/reports/balance-sheet?to=2099-12-31')).body.difference).toBe(0);
  });

  it('shows profit before this financial year as its own equity line', async () => {
    await record('2026-06-30', 'Last year', [[CASH, 400_000, 0], [SERVICE_INCOME, 0, 400_000]]);
    await record('2026-07-02', 'This year', [[OFFICE, 100_000, 0], [CASH, 0, 100_000]]);
    const sheet = (await (await as('rita')).get('/accounts/reports/balance-sheet?to=2026-07-31')).body;
    expect(sheet.equity.profitRows).toEqual([
      { key: 'earlierProfit', label: 'Profit from earlier years', amount: 400_000 },
      { key: 'yearProfit', label: 'Profit this financial year', amount: -100_000 },
    ]);
    expect(sheet.difference).toBe(0);
  });
});
