import type { Application } from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { runInTransaction } from '../src/db.js';
import { paisaToTaka, toCsv } from '../src/modules/accounts/exports/csv.js';
import { validateChartOfAccountsFile } from '../src/modules/accounts/ledgerAccount/chartOfAccountsFile.js';
import { insertMissingLedgerAccounts } from '../src/modules/accounts/ledgerAccount/ledgerAccount.repository.js';
import { AccessProfile } from '../src/modules/master/models/accessProfile.js';
import { AuditLog } from '../src/modules/master/models/auditLog.js';
import { useTestDatabase } from './helpers/database.js';
import { addPerson, importSeedManifests, requestsAs, signIn } from './helpers/signedIn.js';
import { readSeedFiles } from './helpers/testAccess.js';
import { createTestConfig } from './helpers/testConfig.js';

const VOUCHERS = '/accounts/journal-vouchers';
const EXPORTS = '/accounts/exports';
const CASH = 'la_1100';
const OPENING_EQUITY = 'la_3900';
const SERVICE_INCOME = 'la_4100';
const OFFICE = 'la_5500';

/** The CSV body as rows of cells, without the byte order mark. Good enough for files with no quoted commas. */
const rowsOf = (csv: string) => csv.replace(/^﻿/, '').trimEnd().split('\r\n').map((line) => line.split(','));

describe('Export center and the Accounts assistant tools', () => {
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
      { _id: 'ap_ex_reader', name: 'Books reader', grants: { master: { apiToken: { actions: ['create'] } }, accounts: { ledgerAccount: { actions: ['read'] }, journalVoucher: { actions: ['read'] } } } },
      { _id: 'ap_ex_banker', name: 'Books reader with bank numbers', grants: { accounts: { ledgerAccount: { actions: ['read'], fieldAccess: { bankAccountNumber: 'read' } } } } },
      { _id: 'ap_ex_payroll', name: 'Payroll totals only', grants: { accounts: { payrollRun: { actions: ['read'] } } } },
      { _id: 'ap_ex_none', name: 'Settings only', grants: { master: { apiToken: { actions: ['create'] } }, accounts: { setting: { actions: ['read'] } } } },
      { _id: 'ap_ex_approver', name: 'Approver', grants: { accounts: { journalVoucher: { actions: ['read', 'approve'] } } } },
    ]);
    await addPerson('farhana', { superAdmin: true });
    await addPerson('rita', { profileId: 'ap_ex_reader' });
    await addPerson('bashir', { profileId: 'ap_ex_banker' });
    await addPerson('parvin', { profileId: 'ap_ex_payroll' });
    await addPerson('sohel', { profileId: 'ap_ex_none' });
    await addPerson('nadia', { profileId: 'ap_ex_approver' });
  });

  async function record(voucherDate: string, memo: string, lines: [string, number, number][]) {
    const farhana = await as('farhana');
    const created = await farhana.post(VOUCHERS, { voucherDate, memo, lines: lines.map(([accountId, debit, credit]) => ({ accountId, debit, credit })) });
    expect(created.status).toBe(201);
    await farhana.post(`${VOUCHERS}/${created.body.id}/submit`);
    expect((await (await as('nadia')).post(`${VOUCHERS}/${created.body.id}/approve`)).status).toBe(200);
  }

  describe('CSV writing', () => {
    it('writes paisa as taka with two decimals, negatives included', () => {
      expect([paisaToTaka(0), paisaToTaka(5), paisaToTaka(12_345), paisaToTaka(-5), paisaToTaka(-1_000_000)]).toEqual(['0.00', '0.05', '123.45', '-0.05', '-10000.00']);
    });

    it('quotes commas and quotes, and stops text from running as a spreadsheet formula', () => {
      const csv = toCsv(['Memo', 'Amount'], [['Rent, "Gulshan"', 1], ['=HYPERLINK("x")', null], ['-2+3', { taka: '-0.05' }]]);
      expect(csv).toBe('﻿Memo,Amount\r\n"Rent, ""Gulshan""",1\r\n"\'=HYPERLINK(""x"")",\r\n\'-2+3,-0.05\r\n');
    });
  });

  it('needs a session and at least one exportable read permission', async () => {
    expect((await request(app).get(EXPORTS)).status).toBe(401);
    expect((await (await as('sohel')).get(EXPORTS)).status).toBe(403);
    expect((await (await as('sohel')).get(`${EXPORTS}/trial-balance`)).status).toBe(403);
  });

  it('lists only what the person may export', async () => {
    const rita = (await (await as('rita')).get(EXPORTS)).body.datasets.map((each: { key: string }) => each.key);
    expect(rita).toEqual(['profit-and-loss', 'balance-sheet', 'cash-flow', 'trial-balance', 'chart-of-accounts', 'vouchers']);
    // Payroll totals, but not salary per person: the profile hides the lines field it is made of.
    expect((await (await as('parvin')).get(EXPORTS)).body.datasets.map((each: { key: string }) => each.key)).toEqual(['payroll-runs']);
    const everything = (await (await as('farhana')).get(EXPORTS)).body.datasets;
    expect(everything).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'salaries', group: 'People money', period: 'none' })]));
  });

  it('the Day 6 test: a field the profile hides is missing from the CSV, header and all', async () => {
    const withNumber = await (await as('bashir')).get(`${EXPORTS}/chart-of-accounts`);
    expect(withNumber.status).toBe(200);
    expect(rowsOf(withNumber.text)[0]).toContain('Bank account number');

    const withoutNumber = await (await as('rita')).get(`${EXPORTS}/chart-of-accounts`);
    expect(withoutNumber.status).toBe(200);
    expect(withoutNumber.headers['content-type']).toContain('text/csv');
    expect(withoutNumber.headers['content-disposition']).toMatch(/attachment; filename="?chart-of-accounts-\d{4}-\d{2}-\d{2}\.csv/);
    const [headers, ...rows] = rowsOf(withoutNumber.text);
    expect(headers).not.toContain('Bank account number');
    expect(headers).toEqual(['Code', 'Account', 'Type', 'Cash or bank', 'Bank', 'Balance (Tk)', 'Active']);
    expect(rows.every((row) => row.length === headers!.length)).toBe(true);

    expect((await (await as('parvin')).get(`${EXPORTS}/salaries`)).body.error.code).toBe('field_hidden');
  });

  it('exports a report for a period, in taka, and writes the download to the audit log', async () => {
    await record('2026-11-01', 'Opening cash', [[CASH, 10_000_000, 0], [OPENING_EQUITY, 0, 10_000_000]]);
    await record('2026-11-03', 'November work', [[CASH, 8_000_000, 0], [SERVICE_INCOME, 0, 8_000_000]]);
    await record('2026-11-25', '=SUM(A1:A9)', [[OFFICE, 12_345, 0], [CASH, 0, 12_345]]);
    const rita = await as('rita');

    const profitAndLoss = await rita.get(`${EXPORTS}/profit-and-loss?from=2026-11-01&to=2026-11-30`);
    expect(profitAndLoss.headers['content-disposition']).toContain('profit-and-loss-2026-11-01-to-2026-11-30.csv');
    expect(rowsOf(profitAndLoss.text)).toEqual([
      ['Section', 'Code', 'Account', 'Amount (Tk)'],
      ['Income', '4100', 'Service income', '80000.00'],
      ['Income', '', 'Total income', '80000.00'],
      ['Expenses', '5500', 'Office expenses', '123.45'],
      ['Expenses', '', 'Total expenses', '123.45'],
      ['', '', 'Net profit', '79876.55'],
    ]);
    expect(await AuditLog.countDocuments({ action: 'accounts.exported', targetId: 'profit-and-loss' })).toBe(1);

    const vouchers = await rita.get(`${EXPORTS}/vouchers`);
    expect(vouchers.text).toContain("'=SUM(A1:A9)");
    expect(rowsOf(vouchers.text)).toHaveLength(4);
  });

  it('refuses an unknown export, one the profile lacks, and a missing or reversed period', async () => {
    const rita = await as('rita');
    expect((await rita.get(`${EXPORTS}/payslips`)).status).toBe(404);
    expect((await rita.get(`${EXPORTS}/bills`)).status).toBe(403);
    expect((await rita.get(`${EXPORTS}/profit-and-loss?from=2026-11-01`)).status).toBe(422);
    expect((await rita.get(`${EXPORTS}/balance-sheet`)).status).toBe(422);
    expect((await rita.get(`${EXPORTS}/cash-flow?from=2026-11-30&to=2026-11-01`)).status).toBe(422);
    expect((await rita.get(`${EXPORTS}/Bad_Name`)).status).toBe(422);
  });

  describe('assistant tools', () => {
    const tokenFor = async (id: string) => (await (await as(id)).post('/me/api-tokens', { name: 'Claude' })).body.token as string;

    async function callTool(token: string, name: string, args: object = {}) {
      const response = await request(app)
        .post('/mcp')
        .set('Authorization', `Bearer ${token}`)
        .set('Accept', 'application/json, text/event-stream')
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
      const result = response.body.result as { isError?: boolean; content: { text: string }[] };
      const text = result.content[0]!.text;
      return { isError: Boolean(result.isError), text, data: result.isError ? undefined : JSON.parse(text) };
    }

    it('offers read-only tools for balances and the four reports', async () => {
      const token = await tokenFor('rita');
      const response = await request(app).post('/mcp').set('Authorization', `Bearer ${token}`).set('Accept', 'application/json, text/event-stream').send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      const tools = (response.body.result.tools as { name: string; annotations?: { readOnlyHint?: boolean } }[]).filter((tool) => tool.name.startsWith('accounts_'));
      expect(tools.map((tool) => tool.name)).toEqual(['accounts_dashboard', 'accounts_cash_and_bank', 'accounts_trial_balance', 'accounts_profit_and_loss', 'accounts_balance_sheet', 'accounts_cash_flow']);
      expect(tools.every((tool) => tool.annotations?.readOnlyHint)).toBe(true);
    });

    it('answers with the same figures as the reports, and refuses without chart access', async () => {
      await record('2026-11-01', 'Opening cash', [[CASH, 10_000_000, 0], [OPENING_EQUITY, 0, 10_000_000]]);
      await record('2026-11-03', 'November work', [[CASH, 8_000_000, 0], [SERVICE_INCOME, 0, 8_000_000]]);
      const token = await tokenFor('rita');
      expect((await callTool(token, 'accounts_profit_and_loss', { from: '2026-11-01', to: '2026-11-30' })).data).toMatchObject({ netProfit: 8_000_000 });
      expect((await callTool(token, 'accounts_balance_sheet', { to: '2026-11-30' })).data).toMatchObject({ difference: 0, assets: { total: 18_000_000 } });
      expect((await callTool(token, 'accounts_dashboard', { month: '2026-11' })).data).toMatchObject({ cash: { total: 18_000_000 } });
      expect((await callTool(token, 'accounts_cash_and_bank', { from: '2026-11-01', to: '2026-11-30' })).data.totals).toMatchObject({ balance: 18_000_000 });
      expect((await callTool(token, 'accounts_cash_flow', { from: '2026-11-30', to: '2026-11-01' })).isError).toBe(true);

      const refused = await callTool(await tokenFor('sohel'), 'accounts_trial_balance');
      expect(refused).toMatchObject({ isError: true, text: expect.stringContaining('ledgerAccount.read') });
    });
  });
});
