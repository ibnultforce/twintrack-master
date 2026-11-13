import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Application } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createLocalStorage } from '../src/lib/storage/localStorage.js';
import { createAccountsRoutes } from '../src/modules/accounts/accounts.routes.js';
import { Vendor } from '../src/modules/accounts/models/masterData.js';
import { AccessProfile } from '../src/modules/master/models/accessProfile.js';
import { IncentiveLedgerEntry } from '../src/modules/tasks/models/incentive.js';
import { Task } from '../src/modules/tasks/models/task.js';
import { seedDatabase } from '../src/seed/seedDatabase.js';
import { useTestDatabase } from './helpers/database.js';
import { requestsAs, signIn } from './helpers/signedIn.js';
import { readSeedFiles } from './helpers/testAccess.js';
import { createTestConfig, TEST_ORIGIN } from './helpers/testConfig.js';
import { createRecordingEmailSender } from './helpers/testEmail.js';

const PASSWORD = 'correct-password';
const API_URL = 'http://localhost:4100';
const ID = { FARHANA: 'u_01', RAHIM: 'u_04', RUMANA: 'u_05', KAMRUL: 'u_06', MEHEDI: 'u_09' };
const KEY = Buffer.from('d'.repeat(64), 'hex');
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Kamrul (HR admin) runs Accounts day to day but can't approve. Rumana (auditor, the finance lead) reads everything and
 * approves. Farhana is the super admin, who still can't approve her own bills or runs.
 */
describe('Accounts module', () => {
  useTestDatabase();

  const folder = mkdtempSync(join(tmpdir(), 'twintrack-accounts-'));
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
    email.sent.length = 0;
    await seedDatabase({ files: readSeedFiles(), password: PASSWORD, nodeEnv: 'test' });
  });

  async function setUpMoney() {
    const kamrul = await as('kamrul');
    const vendor = (await kamrul.post('/accounts/vendors', { name: 'Dhaka Office Supplies', bankAccountNumber: '0011223344' })).body;
    const bank = (await kamrul.post('/accounts/bank-accounts', { name: 'Operating', currency: 'BDT', openingBalance: 100000, openingDate: '2026-01-01' })).body;
    return { kamrul, vendor, bank };
  }

  async function approvedBill(amount = 30000, currency = 'BDT') {
    const money = await setUpMoney();
    const bill = (await money.kamrul.post('/accounts/bills', { vendorId: money.vendor.id, businessDate: '2026-06-01', currency, amount })).body;
    await money.kamrul.post(`/accounts/bills/${bill.id}/submit`);
    const approved = await (await as('rumana')).post(`/accounts/bills/${bill.id}/approve`);
    expect(approved.body.status).toBe('approved');
    return { ...money, bill: approved.body };
  }

  it('lists every built route in the manifest, with the same access rule', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../manifests/accounts.manifest.json', import.meta.url), 'utf8'));
    const built = createAccountsRoutes(config, { fileStorage: storage, emailSender: email }).map((route) => `${route.method} ${route.path} ${route.access} ${(route as { permission?: string }).permission}`);
    const listed = manifest.routes.map((route: { method: string; path: string; access: string; permission: string }) => `${route.method} /accounts${route.path} ${route.access} ${route.permission}`);
    expect(listed.sort()).toEqual(built.sort());
  });

  describe('categories, vendors and bank accounts', () => {
    it('keeps category codes unique and upper case, and refuses a parent loop', async () => {
      const kamrul = await as('kamrul');
      const parent = (await kamrul.post('/accounts/categories', { name: 'Office', code: 'office' })).body;
      expect(parent.code).toBe('OFFICE');
      const child = (await kamrul.post('/accounts/categories', { name: 'Rent', code: 'office-rent', parentId: parent.id })).body;
      expect((await kamrul.post('/accounts/categories', { name: 'Again', code: 'OFFICE' })).body.error.code).toBe('code_taken');
      expect((await kamrul.patch(`/accounts/categories/${parent.id}`, { parentId: child.id })).body.error.fields[0].path).toBe('parentId');
      expect((await kamrul.patch(`/accounts/categories/${child.id}`, { status: 'inactive' })).body.status).toBe('inactive');
      expect((await kamrul.get(`/accounts/categories/${child.id}/history`)).body.entries[0].changes).toEqual([{ field: 'status', from: 'active', to: 'inactive' }]);
    });

    it('stores a vendor bank number encrypted, and shows it only to people whose field access reaches it', async () => {
      const { vendor } = await setUpMoney();
      expect(vendor.bankAccountNumber).toBe('0011223344');
      const stored = await Vendor.findById(vendor.id).lean();
      expect(JSON.stringify(stored)).not.toContain('0011223344');
      expect((await (await as('rumana')).get(`/accounts/vendors/${vendor.id}`)).body.bankAccountNumber).toBe('0011223344');

      await AccessProfile.updateOne({ _id: 'ap_auditor' }, { $unset: { 'grants.accounts.vendor.fieldAccess': 1 } });
      expect((await (await as('rumana')).get(`/accounts/vendors/${vendor.id}`)).body).not.toHaveProperty('bankAccountNumber');
    });

    it('refuses anyone without Accounts access', async () => {
      expect((await (await as('rahim')).get('/accounts/vendors')).status).toBe(403);
      expect((await (await as('rumana')).post('/accounts/vendors', { name: 'Nope' })).status).toBe(403);
    });

    it('saves company bank details field by field', async () => {
      const kamrul = await as('kamrul');
      await kamrul.patch('/accounts/company-bank-details', { bankName: 'City Bank', accountNumber: '123' });
      const saved = (await kamrul.patch('/accounts/company-bank-details', { swiftCode: 'CIBLBDDH', accountNumber: '' })).body;
      expect(saved).toMatchObject({ bankName: 'City Bank', swiftCode: 'CIBLBDDH' });
      expect(saved).not.toHaveProperty('accountNumber');
    });
  });

  describe('bills and payments', () => {
    it('needs someone other than its maker to approve, and a reason to reject', async () => {
      const farhana = await as('farhana');
      const { vendor } = await setUpMoney();
      const bill = (await farhana.post('/accounts/bills', { vendorId: vendor.id, businessDate: '2026-06-01', currency: 'BDT', amount: 5000 })).body;
      expect((await farhana.post(`/accounts/bills/${bill.id}/approve`)).body.error.code).toBe('invalid_status');
      await farhana.post(`/accounts/bills/${bill.id}/submit`);
      expect((await farhana.post(`/accounts/bills/${bill.id}/approve`)).body.error.code).toBe('own_record');
      expect((await (await as('kamrul')).post(`/accounts/bills/${bill.id}/approve`)).status).toBe(403);
      expect((await (await as('rumana')).post(`/accounts/bills/${bill.id}/reject`, {})).status).toBe(422);
      expect((await (await as('rumana')).post(`/accounts/bills/${bill.id}/reject`, { reason: 'Wrong vendor' })).body).toMatchObject({ status: 'rejected', rejectionReason: 'Wrong vendor', decidedBy: ID.RUMANA });
    });

    it('changes and deletes only drafts', async () => {
      const { kamrul, vendor } = await setUpMoney();
      const bill = (await kamrul.post('/accounts/bills', { vendorId: vendor.id, businessDate: '2026-06-01', currency: 'BDT', amount: 5000 })).body;
      expect((await kamrul.patch(`/accounts/bills/${bill.id}`, { amount: 6000 })).body.amount).toBe(6000);
      await kamrul.post(`/accounts/bills/${bill.id}/submit`);
      expect((await kamrul.patch(`/accounts/bills/${bill.id}`, { amount: 7000 })).body.error.code).toBe('invalid_status');
      expect((await kamrul.delete(`/accounts/bills/${bill.id}`)).body.error.code).toBe('invalid_status');

      const draft = (await kamrul.post('/accounts/bills', { vendorId: vendor.id, businessDate: '2026-06-01', currency: 'BDT', amount: 1 })).body;
      expect((await kamrul.delete(`/accounts/bills/${draft.id}`)).status).toBe(204);
      expect((await kamrul.get(`/accounts/bills/${draft.id}`)).status).toBe(404);
    });

    it('pays a bill in parts, never beyond what is owed, and moves the bank balance', async () => {
      const { kamrul, bank, bill } = await approvedBill(30000);
      const pay = (amount: number) => kamrul.post('/accounts/payments', { bankAccountId: bank.id, billId: bill.id, payeeType: 'vendor', amount, paymentDate: '2026-06-05', method: 'bank_transfer' });
      const first = await pay(10000);
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      expect(first.body).toMatchObject({ currency: 'BDT', payeeVendorId: bill.vendorId, payeeName: 'Dhaka Office Supplies', inEffect: true });
      expect((await kamrul.get(`/accounts/bills/${bill.id}`)).body).toMatchObject({ status: 'partially_paid', paidAmount: 10000, outstandingAmount: 20000 });
      expect((await pay(25000)).body.error.fields[0].path).toBe('amount');
      await pay(20000);
      expect((await kamrul.get(`/accounts/bills/${bill.id}`)).body.status).toBe('paid');
      expect((await pay(1)).body.error.code).toBe('bill_not_payable');
      expect((await kamrul.get(`/accounts/bank-accounts/${bank.id}`)).body.currentBalance).toBe(70000);
    });

    it("refuses paying from an account in another currency than the bill's", async () => {
      const { kamrul, bill } = await approvedBill(100, 'USD');
      const bdt = (await kamrul.post('/accounts/bank-accounts', { name: 'Taka', currency: 'BDT' })).body;
      const response = await kamrul.post('/accounts/payments', { bankAccountId: bdt.id, billId: bill.id, payeeType: 'vendor', amount: 100, paymentDate: '2026-06-05', method: 'cash' });
      expect(response.body.error.fields[0].path).toBe('bankAccountId');
    });

    it('reverses a payment once, putting the bill back to owing it and the money back in the bank', async () => {
      const { kamrul, bank, bill } = await approvedBill(30000);
      const payment = (await kamrul.post('/accounts/payments', { bankAccountId: bank.id, billId: bill.id, payeeType: 'vendor', amount: 30000, paymentDate: '2026-06-05', method: 'cash' })).body;
      expect((await kamrul.post(`/accounts/bills/${bill.id}/reverse`, { reason: 'Wrong' })).body.error.code).toBe('bill_has_payments');

      const reversal = await kamrul.post(`/accounts/payments/${payment.id}/reverse`, { reason: 'Bank returned it' });
      expect(reversal.status).toBe(201);
      expect(reversal.body).toMatchObject({ reversesId: payment.id, inEffect: false, amount: 30000 });
      expect((await kamrul.get(`/accounts/payments/${payment.id}`)).body).toMatchObject({ reversalId: reversal.body.id, inEffect: false });
      expect((await kamrul.post(`/accounts/payments/${payment.id}/reverse`, { reason: 'Again' })).body.error.code).toBe('already_reversed');
      expect((await kamrul.post(`/accounts/payments/${reversal.body.id}/reverse`, { reason: 'Again' })).body.error.code).toBe('is_reversal');
      expect((await kamrul.get(`/accounts/bills/${bill.id}`)).body).toMatchObject({ status: 'approved', outstandingAmount: 30000 });
      expect((await kamrul.get(`/accounts/bank-accounts/${bank.id}`)).body.currentBalance).toBe(100000);

      expect((await kamrul.post(`/accounts/bills/${bill.id}/reverse`, { reason: 'Duplicate bill' })).body).toMatchObject({ status: 'reversed', reversalReason: 'Duplicate bill' });
    });

    it('pays employees and others too, naming exactly one payee', async () => {
      const { kamrul, bank } = await setUpMoney();
      const base = { bankAccountId: bank.id, amount: 500, paymentDate: '2026-06-05', method: 'cash' };
      expect((await kamrul.post('/accounts/payments', { ...base, payeeType: 'employee' })).body.error.fields[0].path).toBe('payeeUserId');
      expect((await kamrul.post('/accounts/payments', { ...base, payeeType: 'employee', payeeUserId: ID.MEHEDI })).body.payeeName).toBe('Mehedi Hasan');
      expect((await kamrul.post('/accounts/payments', { ...base, payeeType: 'other', payeeName: 'Tea stall' })).body.payeeName).toBe('Tea stall');
    });

    it('lists money in and out on a statement with a running balance', async () => {
      const { kamrul, bank } = await setUpMoney();
      await kamrul.post('/accounts/payments', { bankAccountId: bank.id, payeeType: 'other', payeeName: 'Rent', amount: 20000, paymentDate: '2026-03-01', method: 'cash' });
      await kamrul.post('/accounts/receipts', { bankAccountId: bank.id, amount: 5000, bankFee: 100, receivedDate: '2026-05-01', method: 'bank_transfer' });
      const statement = (await kamrul.get(`/accounts/bank-accounts/${bank.id}/statement?from=2026-04-01&to=2026-12-31`)).body;
      expect(statement).toMatchObject({ openingBalance: 80000, closingBalance: 84900 });
      expect(statement.entries).toEqual([expect.objectContaining({ kind: 'receipt', amount: 4900, balance: 84900 })]);
    });
  });

  describe('invoices and receipts', () => {
    /** A client whose project has one finished 6-hour task and one finished non-billable 2-hour task. */
    async function billableWork() {
      const client = (await (await as('farhana')).post('/clients', { name: 'Acme Logistics Ltd', contactEmail: 'ap@acme.test', address: 'Gulshan, Dhaka' })).body;
      const rahim = await as('rahim');
      const project = (await rahim.post('/tasks/projects', { name: 'Payroll revamp', memberIds: [ID.MEHEDI], clientId: client.id })).body;
      const mehedi = await as('mehedi');
      const finish = async (title: string, estimatedHours: number, billable = true) => {
        const task = (await rahim.post('/tasks/tasks', { projectId: project.id, title, assignedDevId: ID.MEHEDI, estimatedHours, billable })).body;
        await mehedi.post(`/tasks/tasks/${task.id}/start`);
        await mehedi.post(`/tasks/tasks/${task.id}/complete`);
        await rahim.post(`/tasks/tasks/${task.id}/approve`, { hours: { basis: 'estimated' } });
        return task;
      };
      const export_ = await finish('Export salaries', 6);
      const meeting = await finish('Kick-off meeting', 2, false);
      return { client, project, tasks: [export_, meeting] };
    }

    it('bills a client its finished work at the estimate, marks the tasks billed, and makes a Word document', async () => {
      const { client, tasks } = await billableWork();
      const kamrul = await as('kamrul');
      expect((await kamrul.get('/accounts/invoices/unbilled')).body).toMatchObject({ totalHours: 6, projects: [expect.objectContaining({ hours: 6, clientName: 'Acme Logistics Ltd' })] });
      expect((await kamrul.get(`/accounts/invoices/preview?clientId=${client.id}&from=${today()}&to=${today()}`)).body).toMatchObject({ totalHours: 8, billableHours: 6, amount: 150 });

      const created = await kamrul.post('/accounts/invoices', { clientId: client.id, from: today(), to: today() });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const yy = today().slice(2, 4);
      expect(created.body).toMatchObject({ clientName: 'Acme Logistics Ltd', basis: 'completed', currency: 'USD', hourlyRate: 25, totalHours: 8, billableHours: 6, amount: 150, status: 'draft', hasDocument: true, documentVersion: 1 });
      expect(created.body.invoiceNumber).toMatch(new RegExp(`^TFS-AL-\\d{2}-\\d{2}-${yy}$`));
      expect(created.body.lines).toEqual(expect.arrayContaining([expect.objectContaining({ description: 'Kick-off meeting', billable: false, amount: 0 })]));
      expect((await Task.findById(tasks[0].id).lean())?.invoiceId).toBe(created.body.id);
      expect((await kamrul.get('/accounts/invoices/unbilled')).body.totalHours).toBe(0);

      const second = (await kamrul.post('/accounts/invoices', { clientId: client.id, from: today(), to: today() })).body;
      expect(second.invoiceNumber).toBe(`${created.body.invoiceNumber}-2`);

      const { url } = (await kamrul.get(`/accounts/invoices/${created.body.id}/document`)).body;
      const document = await request(app).get(url.slice(API_URL.length)).buffer(true).parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      });
      expect(document.status).toBe(200);
      // A .docx is a zip file.
      expect((document.body as Buffer).subarray(0, 2).toString()).toBe('PK');
    });

    it('bills logged work for chosen projects with custom lines, and refuses projects of two clients', async () => {
      const { project } = await billableWork();
      const kamrul = await as('kamrul');
      const created = await kamrul.post('/accounts/invoices', { projectIds: [project.id], from: today(), to: today(), hourlyRate: 40, customLines: [{ projectId: project.id, description: 'Server setup', hours: 3 }] });
      expect(created.body).toMatchObject({ basis: 'logged', billableHours: 9, amount: 360 });
      expect(created.body.lines).toEqual(expect.arrayContaining([expect.objectContaining({ description: 'Server setup', custom: true })]));

      const other = (await (await as('farhana')).post('/clients', { name: 'Beta Corp' })).body;
      const otherProject = (await (await as('rahim')).post('/tasks/projects', { name: 'Beta site', clientId: other.id })).body;
      expect((await kamrul.post('/accounts/invoices', { projectIds: [project.id, otherProject.id], from: today(), to: today() })).body.error.fields[0].path).toBe('projectIds');
      expect((await kamrul.post('/accounts/invoices', { clientId: other.id, from: today(), to: today() })).body.error.code).toBe('nothing_to_invoice');
    });

    it('edits a draft invoice lines, emails it with the document, then keeps the figures', async () => {
      const { client } = await billableWork();
      const kamrul = await as('kamrul');
      const invoice = (await kamrul.post('/accounts/invoices', { clientId: client.id, from: today(), to: today() })).body;
      const line = invoice.lines.find((candidate: { description: string }) => candidate.description === 'Export salaries');
      const edited = (await kamrul.patch(`/accounts/invoices/${invoice.id}/lines`, { lines: [{ id: line.id, hours: 4, description: 'Salary export' }] })).body;
      expect(edited).toMatchObject({ billableHours: 4, amount: 100, documentVersion: 2 });

      const sent = (await kamrul.post(`/accounts/invoices/${invoice.id}/send`, {})).body;
      expect(sent).toMatchObject({ status: 'sent', emailedTo: 'ap@acme.test' });
      expect(email.sent.at(-1)).toMatchObject({ to: 'ap@acme.test', attachments: [expect.objectContaining({ fileName: `${invoice.invoiceNumber}.docx` })] });
      expect((await kamrul.patch(`/accounts/invoices/${invoice.id}/lines`, { hourlyRate: 99 })).body.error.code).toBe('invalid_status');
      expect((await kamrul.patch(`/accounts/invoices/${invoice.id}`, { status: 'draft' })).body.error.code).toBe('invalid_status');
      expect((await kamrul.delete(`/accounts/invoices/${invoice.id}`)).body.error.code).toBe('invalid_status');
    });

    it('deleting a draft invoice makes its tasks unbilled again', async () => {
      const { client, tasks } = await billableWork();
      const kamrul = await as('kamrul');
      const invoice = (await kamrul.post('/accounts/invoices', { clientId: client.id, from: today(), to: today() })).body;
      expect((await kamrul.delete(`/accounts/invoices/${invoice.id}`)).status).toBe(204);
      expect((await Task.findById(tasks[0].id).lean())?.invoiceId).toBeUndefined();
      expect((await kamrul.get('/accounts/invoices/unbilled')).body.totalHours).toBe(6);
    });

    it('counts receipts against invoices, never beyond either, and reverses a receipt only once unallocated', async () => {
      const { client } = await billableWork();
      const kamrul = await as('kamrul');
      const invoice = (await kamrul.post('/accounts/invoices', { clientId: client.id, from: today(), to: today() })).body;
      const usd = (await kamrul.post('/accounts/bank-accounts', { name: 'Dollar', currency: 'USD' })).body;
      const receipt = (await kamrul.post('/accounts/receipts', { bankAccountId: usd.id, clientId: client.id, amount: 200, bankFee: 5, receivedDate: today(), method: 'bank_transfer' })).body;
      expect(receipt).toMatchObject({ currency: 'USD', netAmount: 195, unallocatedAmount: 200 });

      expect((await kamrul.post(`/accounts/receipts/${receipt.id}/allocations`, { invoiceId: invoice.id, amount: 160 })).body.error.fields[0].path).toBe('amount');
      const allocated = (await kamrul.post(`/accounts/receipts/${receipt.id}/allocations`, { invoiceId: invoice.id, amount: 150 })).body;
      expect(allocated).toMatchObject({ allocatedAmount: 150, unallocatedAmount: 50, allocations: [expect.objectContaining({ invoiceNumber: invoice.invoiceNumber })] });
      expect((await kamrul.get(`/accounts/invoices/${invoice.id}`)).body).toMatchObject({ paidAmount: 150, outstandingAmount: 0 });

      expect((await kamrul.post(`/accounts/receipts/${receipt.id}/reverse`, { reason: 'Bounced' })).body.error.code).toBe('receipt_allocated');
      await kamrul.delete(`/accounts/receipts/${receipt.id}/allocations/${allocated.allocations[0].id}`);
      expect((await kamrul.post(`/accounts/receipts/${receipt.id}/reverse`, { reason: 'Bounced' })).status).toBe(201);
      expect((await kamrul.get(`/accounts/bank-accounts/${usd.id}`)).body.currentBalance).toBe(0);
    });
  });

  describe('payroll', () => {
    const month = { month: 6, year: 2026 };

    it("pays each person's HR salary plus their unpaid Tasks incentive, approved by someone else", async () => {
      await IncentiveLedgerEntry.create({ _id: 'il_1', userId: ID.RAHIM, month: 6, year: 2026, completedHours: 10, hourlyRate: 500, totalPayout: 5000, disbursed: false });
      const kamrul = await as('kamrul');
      const created = await kamrul.post('/accounts/payroll-runs', { ...month, userIds: [ID.RAHIM, ID.RUMANA] });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const rahimItem = created.body.items.find((item: { userId: string }) => item.userId === ID.RAHIM);
      expect(rahimItem).toMatchObject({ name: 'Rahim Uddin', salaryAmount: 180000, incentiveAmount: 5000, grossAmount: 185000, netAmount: 185000, settlementStatus: 'unpaid' });
      expect(created.body.totals).toEqual([{ currency: 'BDT', netAmount: 335000 }]);

      const withDeduction = (await kamrul.patch(`/accounts/payroll-runs/${created.body.id}`, { deductions: [{ itemId: rahimItem.id, amount: 1000 }] })).body;
      expect(withDeduction.items.find((item: { id: string }) => item.id === rahimItem.id).netAmount).toBe(184000);
      expect((await kamrul.patch(`/accounts/payroll-runs/${created.body.id}/items/${rahimItem.id}`, { settlementStatus: 'paid' })).body.error.code).toBe('invalid_status');

      await kamrul.post(`/accounts/payroll-runs/${created.body.id}/submit`);
      expect((await kamrul.post(`/accounts/payroll-runs/${created.body.id}/approve`)).status).toBe(403);
      const rumana = await as('rumana');
      expect((await rumana.post(`/accounts/payroll-runs/${created.body.id}/approve`)).body.status).toBe('approved');

      await kamrul.patch(`/accounts/payroll-runs/${created.body.id}/items/${rahimItem.id}`, { settlementStatus: 'paid', reference: 'TRX-1' });
      expect(await IncentiveLedgerEntry.findById('il_1').lean()).toMatchObject({ disbursed: true, disbursedBy: ID.KAMRUL });
      const other = created.body.items.find((item: { userId: string }) => item.userId === ID.RUMANA);
      const done = (await kamrul.patch(`/accounts/payroll-runs/${created.body.id}/items/${other.id}`, { settlementStatus: 'failed' })).body;
      expect(done).toMatchObject({ status: 'completed', paidCount: 1 });
    });

    it('allows one run a month, which deleting the draft frees, and refuses people with no approved salary', async () => {
      const kamrul = await as('kamrul');
      const run = (await kamrul.post('/accounts/payroll-runs', { ...month, userIds: [ID.RAHIM] })).body;
      expect((await kamrul.post('/accounts/payroll-runs', { ...month, userIds: [ID.RAHIM] })).body.error.code).toBe('run_exists');
      expect((await kamrul.delete(`/accounts/payroll-runs/${run.id}`)).status).toBe(204);
      expect((await kamrul.post('/accounts/payroll-runs', { ...month, userIds: [ID.RAHIM] })).status).toBe(201);
      expect((await kamrul.post('/accounts/payroll-runs', { month: 7, year: 2026, userIds: [ID.MEHEDI] })).body.error.fields[0].path).toBe('userIds');
    });

    it('lets the approver send a run back to draft with a reason, but not their own', async () => {
      const farhana = await as('farhana');
      const run = (await farhana.post('/accounts/payroll-runs', { ...month, userIds: [ID.RAHIM] })).body;
      await farhana.post(`/accounts/payroll-runs/${run.id}/submit`);
      expect((await farhana.post(`/accounts/payroll-runs/${run.id}/return`, { reason: 'Check' })).body.error.code).toBe('own_record');
      expect((await (await as('rumana')).post(`/accounts/payroll-runs/${run.id}/return`, { reason: 'Missing people' })).body).toMatchObject({ status: 'draft', returnReason: 'Missing people' });
    });
  });

  describe('documents', () => {
    it('uploads evidence to a bill and serves it, for people who can read the bill', async () => {
      const { kamrul, bill } = await approvedBill();
      const content = Buffer.from('receipt scan');
      const started = await kamrul.post('/accounts/documents', { ownerType: 'bill', ownerId: bill.id, fileName: 'scan.txt', mimeType: 'text/plain', sizeBytes: content.length });
      expect(started.status, JSON.stringify(started.body)).toBe(201);
      const documentId = started.body.document.id;
      const { parts } = (await kamrul.post(`/accounts/documents/${documentId}/part-urls`, { partNumbers: [1] })).body;
      const put = await request(app).put(parts[0].url.slice(API_URL.length)).set('Origin', TEST_ORIGIN).set('Content-Type', 'text/plain').send(content);
      const completed = await kamrul.post(`/accounts/documents/${documentId}/complete`, { parts: [{ partNumber: 1, etag: put.headers.etag }] });
      expect(completed.body).toMatchObject({ status: 'ready', uploadedByName: 'Kamrul Islam' });

      const rumana = await as('rumana');
      expect((await rumana.get(`/accounts/documents?ownerType=bill&ownerId=${bill.id}`)).body.documents).toHaveLength(1);
      const { url } = (await rumana.get(`/accounts/documents/${documentId}/url`)).body;
      expect((await request(app).get(url.slice(API_URL.length))).text).toBe('receipt scan');
      expect((await kamrul.post('/accounts/documents', { ownerType: 'bill', ownerId: 'bill_missing', fileName: 'x.txt', sizeBytes: 1 })).body.error.fields[0].path).toBe('ownerId');
    });

    it("needs read on the document's record", async () => {
      const { bill } = await approvedBill();
      await AccessProfile.updateOne({ _id: 'ap_auditor' }, { $set: { 'grants.accounts.bill.actions': ['approve'] } });
      expect((await (await as('rumana')).get(`/accounts/documents?ownerType=bill&ownerId=${bill.id}`)).status).toBe(403);
    });
  });
});
