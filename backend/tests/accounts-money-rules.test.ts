import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Application } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createLocalStorage } from '../src/lib/storage/localStorage.js';
import { markLedgerEntryPaid } from '../src/modules/tasks/incentive/incentive.repository.js';
import { IncentiveLedgerEntry } from '../src/modules/tasks/models/incentive.js';
import { seedDatabase } from '../src/seed/seedDatabase.js';
import { useTestDatabase } from './helpers/database.js';
import { requestsAs, signIn } from './helpers/signedIn.js';
import { readSeedFiles } from './helpers/testAccess.js';
import { createTestConfig } from './helpers/testConfig.js';
import { createRecordingEmailSender } from './helpers/testEmail.js';

const PASSWORD = 'correct-password';
const API_URL = 'http://localhost:4100';
const ID = { RAHIM: 'u_04', MEHEDI: 'u_09' };
const KEY = Buffer.from('d'.repeat(64), 'hex');
const today = () => new Date().toISOString().slice(0, 10);

/** Money rules in Accounts that a single happy-path call doesn't show: races, currencies, rounding and payees. */
describe('Accounts money rules', () => {
  useTestDatabase();

  const folder = mkdtempSync(join(tmpdir(), 'twintrack-accounts-rules-'));
  const storage = createLocalStorage(folder, API_URL, KEY);
  const email = createRecordingEmailSender();
  const config = createTestConfig({ PUBLIC_API_URL: API_URL, INVOICE_HOURLY_RATE_USD: '25', INVOICE_NUMBER_PREFIX: 'TFS', COMPANY_NAME: 'TwinForce' });
  let app: Application;
  const as = async (name: string) => requestsAs(app, await signIn(app, `${name}@twintrack.test`, PASSWORD));

  beforeAll(() => {
    app = createApp(config, { fileStorage: storage, localStorage: storage, emailSender: email });
  });
  afterAll(() => rmSync(folder, { recursive: true, force: true }));
  beforeEach(async () => {
    await seedDatabase({ files: readSeedFiles(), password: PASSWORD, nodeEnv: 'test' });
  });

  async function approvedBill(amount: number) {
    const kamrul = await as('kamrul');
    const vendor = (await kamrul.post('/accounts/vendors', { name: 'Dhaka Office Supplies' })).body;
    const bank = (await kamrul.post('/accounts/bank-accounts', { name: 'Operating', currency: 'BDT', openingBalance: 100000, openingDate: '2026-01-01' })).body;
    const bill = (await kamrul.post('/accounts/bills', { vendorId: vendor.id, businessDate: '2026-06-01', currency: 'BDT', amount })).body;
    await kamrul.post(`/accounts/bills/${bill.id}/submit`);
    await (await as('rumana')).post(`/accounts/bills/${bill.id}/approve`);
    return { kamrul, bank, bill };
  }

  /** A client with one finished, billable 6-hour task. */
  async function billableWork() {
    const client = (await (await as('farhana')).post('/clients', { name: 'Acme Logistics Ltd', contactEmail: 'ap@acme.test' })).body;
    const rahim = await as('rahim');
    const project = (await rahim.post('/tasks/projects', { name: 'Payroll revamp', memberIds: [ID.MEHEDI], clientId: client.id })).body;
    const mehedi = await as('mehedi');
    const task = (await rahim.post('/tasks/tasks', { projectId: project.id, title: 'Export salaries', assignedDevId: ID.MEHEDI, estimatedHours: 6 })).body;
    await mehedi.post(`/tasks/tasks/${task.id}/start`);
    await mehedi.post(`/tasks/tasks/${task.id}/complete`);
    await rahim.post(`/tasks/tasks/${task.id}/approve`, { hours: { basis: 'estimated' } });
    return { client, project };
  }

  describe('bill payments', () => {
    it('never pays a bill beyond what is owed, even when two payments arrive at once', async () => {
      const { kamrul, bank, bill } = await approvedBill(30000);
      const pay = () => kamrul.post('/accounts/payments', { bankAccountId: bank.id, billId: bill.id, payeeType: 'vendor', amount: 30000, paymentDate: '2026-06-05', method: 'bank_transfer' });
      const responses = await Promise.all([pay(), pay(), pay()]);
      expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
      expect((await kamrul.get(`/accounts/bills/${bill.id}`)).body).toMatchObject({ status: 'paid', paidAmount: 30000, outstandingAmount: 0 });
      expect((await kamrul.get(`/accounts/bank-accounts/${bank.id}`)).body.currentBalance).toBe(70000);
    });

    it("pays a bill only to its vendor, never to another payee", async () => {
      const { kamrul, bank, bill } = await approvedBill(5000);
      const base = { bankAccountId: bank.id, billId: bill.id, amount: 5000, paymentDate: '2026-06-05', method: 'cash' };
      expect((await kamrul.post('/accounts/payments', { ...base, payeeType: 'other', payeeName: 'Tea stall' })).body.error.fields[0].path).toBe('payeeType');
      expect((await kamrul.post('/accounts/payments', { ...base, payeeType: 'employee', payeeUserId: ID.MEHEDI })).body.error.fields[0].path).toBe('payeeType');
      expect((await kamrul.get(`/accounts/bills/${bill.id}`)).body.status).toBe('approved');
    });

    it('refuses money amounts finer than a cent', async () => {
      const { kamrul, bank, bill } = await approvedBill(100);
      const response = await kamrul.post('/accounts/payments', { bankAccountId: bank.id, billId: bill.id, payeeType: 'vendor', amount: 99.996, paymentDate: '2026-06-05', method: 'cash' });
      expect(response.status).toBe(422);
      expect(response.body.error.fields[0].path).toBe('amount');
      expect((await kamrul.post('/accounts/receipts', { bankAccountId: bank.id, amount: 10.1, receivedDate: '2026-06-05', method: 'cash' })).status).toBe(201);
    });
  });

  describe('invoices', () => {
    it("needs a rate for an invoice in taka, because the default rate is in dollars", async () => {
      const { client } = await billableWork();
      const kamrul = await as('kamrul');
      const response = await kamrul.post('/accounts/invoices', { clientId: client.id, from: today(), to: today(), currency: 'BDT' });
      expect(response.status).toBe(422);
      expect(response.body.error.fields[0].path).toBe('hourlyRate');
      expect((await kamrul.post('/accounts/invoices', { clientId: client.id, from: today(), to: today(), currency: 'BDT', hourlyRate: 3000 })).body).toMatchObject({ currency: 'BDT', amount: 18000 });
    });

    it('totals exactly what its lines charge, whatever the rate', async () => {
      const { project } = await billableWork();
      const kamrul = await as('kamrul');
      const line = { projectId: project.id, description: 'Call', hours: 1 };
      const invoice = (await kamrul.post('/accounts/invoices', { projectIds: [project.id], from: today(), to: today(), hourlyRate: 33.333, customLines: [line, line, line] })).body;
      const linesTotal = Math.round(invoice.lines.reduce((sum: number, current: { amount: number }) => sum + current.amount * 100, 0)) / 100;
      expect(linesTotal).toBe(299.99);
      expect(invoice.amount).toBe(linesTotal);
      expect(invoice.projects[0].amount).toBe(linesTotal);
    });

    it("can't lower a draft below what receipts already count against it", async () => {
      const { client } = await billableWork();
      const kamrul = await as('kamrul');
      const invoice = (await kamrul.post('/accounts/invoices', { clientId: client.id, from: today(), to: today() })).body;
      const usd = (await kamrul.post('/accounts/bank-accounts', { name: 'Dollar', currency: 'USD' })).body;
      const receipt = (await kamrul.post('/accounts/receipts', { bankAccountId: usd.id, clientId: client.id, amount: 150, receivedDate: today(), method: 'bank_transfer' })).body;
      await kamrul.post(`/accounts/receipts/${receipt.id}/allocations`, { invoiceId: invoice.id, amount: 150 });

      const response = await kamrul.patch(`/accounts/invoices/${invoice.id}/lines`, { lines: [{ id: invoice.lines[0].id, hours: 4 }] });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('invoice_allocated');
      expect((await kamrul.get(`/accounts/invoices/${invoice.id}`)).body).toMatchObject({ amount: 150, outstandingAmount: 0 });
    });
  });

  describe('payroll', () => {
    const month = { month: 6, year: 2026 };

    async function approvedRun(body: Record<string, unknown>) {
      const kamrul = await as('kamrul');
      const run = (await kamrul.post('/accounts/payroll-runs', { ...month, userIds: [ID.RAHIM], ...body })).body;
      await kamrul.post(`/accounts/payroll-runs/${run.id}/submit`);
      await (await as('rumana')).post(`/accounts/payroll-runs/${run.id}/approve`);
      return { kamrul, run, item: run.items[0] };
    }

    it("never pays a salary out of an account in another currency", async () => {
      const kamrul = await as('kamrul');
      const usd = (await kamrul.post('/accounts/bank-accounts', { name: 'Dollar', currency: 'USD', openingBalance: 1000 })).body;
      const { run, item } = await approvedRun({ bankAccountId: usd.id });
      expect(item.currency).toBe('BDT');
      expect(item.bankAccountId).toBeUndefined();
      await kamrul.patch(`/accounts/payroll-runs/${run.id}/items/${item.id}`, { settlementStatus: 'paid' });
      expect((await kamrul.get(`/accounts/bank-accounts/${usd.id}`)).body.currentBalance).toBe(1000);
    });

    it('refuses to pay an incentive again that Tasks paid after the run was made', async () => {
      await IncentiveLedgerEntry.create({ _id: 'il_1', userId: ID.RAHIM, ...month, completedHours: 10, hourlyRate: 500, totalPayout: 5000, disbursed: false });
      const { kamrul, run, item } = await approvedRun({});
      expect(item.incentiveAmount).toBe(5000);
      await markLedgerEntryPaid(ID.RAHIM, month, { completedHours: 10, hourlyRate: 500, totalPayout: 5000 } as never, 'u_01');

      const response = await kamrul.patch(`/accounts/payroll-runs/${run.id}/items/${item.id}`, { settlementStatus: 'paid' });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('incentive_already_paid');
      expect((await kamrul.get(`/accounts/payroll-runs/${run.id}`)).body.items[0].settlementStatus).toBe('unpaid');
    });

    it('marks the incentive paid once, and can settle the same pay again', async () => {
      await IncentiveLedgerEntry.create({ _id: 'il_1', userId: ID.RAHIM, ...month, completedHours: 10, hourlyRate: 500, totalPayout: 5000, disbursed: false });
      const { kamrul, run, item } = await approvedRun({});
      const settle = (settlementStatus: string) => kamrul.patch(`/accounts/payroll-runs/${run.id}/items/${item.id}`, { settlementStatus });
      expect((await settle('paid')).body.items[0]).toMatchObject({ settlementStatus: 'paid', incentiveMarkedPaid: true });
      expect((await settle('unpaid')).status).toBe(200);
      expect((await settle('paid')).body.items[0].settlementStatus).toBe('paid');
      expect(await IncentiveLedgerEntry.findById('il_1').lean()).toMatchObject({ disbursed: true });
    });
  });
});
