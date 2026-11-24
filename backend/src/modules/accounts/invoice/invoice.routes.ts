import type { Request, RequestHandler } from 'express';
import { z } from 'zod';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { paginationQueryFields } from '../../../lib/query.js';
import { parseRequestBody, parseRequestQuery } from '../../../lib/validation.js';
import { getActor } from '../../master/access/caller.js';
import { accountingDateField, minorUnitsField, recordIdField, versionField } from '../accountsFields.js';
import type { ApprovalSource } from '../approvals/approvalQueue.service.js';
import { rateOn, toPaisa } from '../currency/exchangeRates.js';
import { PAYMENT_STATUSES } from '../documents/documentState.js';
import { INVOICE_STATUSES } from '../models/invoice.js';
import {
  approveInvoice,
  cancelInvoice,
  createInvoice,
  findSubmittedInvoices,
  getInvoice,
  getInvoiceHistory,
  listBillableTasks,
  listInvoices,
  receiveInvoicePayment,
  returnInvoice,
  submitInvoice,
  updateInvoice,
} from './invoice.service.js';
import { getClientStatement, listClientAccounts } from './clientStatements.js';

const MAX_LINES = 200;
const MAX_TEXT = 500;
const MAX_NOTE = 1000;

const currencyField = z.string().trim().regex(/^[A-Z]{3,10}$/, 'must be a currency code, such as BDT or USD');
const itemSchema = z.strictObject({
  description: z.string().trim().min(1, 'is required').max(MAX_TEXT),
  amount: minorUnitsField.min(1, 'must be above zero'),
  milestone: z.string().trim().max(200).optional(),
});
const itemsField = z.array(itemSchema).max(MAX_LINES);
const taskIdsField = z.array(recordIdField).max(MAX_LINES);
const reasonField = z.string().trim().min(1, 'say why').max(MAX_NOTE);

const createBodySchema = z.strictObject({
  clientId: recordIdField,
  issueDate: accountingDateField,
  dueDate: accountingDateField.optional(),
  currency: currencyField.optional(),
  taskIds: taskIdsField.optional(),
  items: itemsField.optional(),
});

const updateBodySchema = z
  .strictObject({
    issueDate: accountingDateField.optional(),
    dueDate: accountingDateField.optional(),
    currency: currencyField.optional(),
    // Each replaces the whole set.
    taskIds: taskIdsField.optional(),
    items: itemsField.optional(),
    reason: reasonField,
    version: versionField.optional(),
  })
  .refine(({ version: _version, reason: _reason, ...changes }) => Object.keys(changes).length > 0, { message: 'send at least one field to change' });

const decisionBodySchema = z.strictObject({ version: versionField.optional() });
const returnBodySchema = z.strictObject({ note: z.string().trim().min(1, 'say what needs fixing').max(MAX_NOTE), version: versionField.optional() });
const cancelBodySchema = z.strictObject({ reason: reasonField, version: versionField.optional() });
const receiveBodySchema = z.strictObject({
  receivedDate: accountingDateField,
  moneyAccountId: recordIdField,
  // In the invoice's currency. Leave out to receive everything still open.
  amount: minorUnitsField.min(1, 'must be above zero').optional(),
  reference: z.string().trim().max(100).optional(),
});

const listQuerySchema = z
  .object({
    ...paginationQueryFields,
    status: z.enum(INVOICE_STATUSES).optional(),
    paymentStatus: z.enum(PAYMENT_STATUSES).optional(),
    clientId: recordIdField.optional(),
    from: accountingDateField.optional(),
    to: accountingDateField.optional(),
    search: z.string().trim().max(100).optional().transform((text) => text || undefined),
  })
  .refine(({ from, to }) => !from || !to || from <= to, { message: 'from must be on or before to', path: ['to'] });

const billableQuerySchema = z
  .object({ clientId: recordIdField, from: accountingDateField, to: accountingDateField })
  .refine(({ from, to }) => from <= to, { message: 'from must be on or before to', path: ['to'] });

const invoiceId = (req: Request) => String(req.params.id);
const bodyOf = (req: Request) => req.body ?? {};

const handleList: RequestHandler = async (req, res) => {
  res.json(await listInvoices(getActor(req), parseRequestQuery(listQuerySchema, req.query)));
};
const handleBillableTasks: RequestHandler = async (req, res) => {
  const { clientId, from, to } = parseRequestQuery(billableQuerySchema, req.query);
  res.json(await listBillableTasks(clientId, from, to));
};
const handleGet: RequestHandler = async (req, res) => {
  res.json(await getInvoice(getActor(req), invoiceId(req)));
};
const handleCreate: RequestHandler = async (req, res) => {
  res.status(201).json(await createInvoice(getActor(req), parseRequestBody(createBodySchema, req.body)));
};
const handleUpdate: RequestHandler = async (req, res) => {
  res.json(await updateInvoice(getActor(req), invoiceId(req), parseRequestBody(updateBodySchema, req.body)));
};
const handleSubmit: RequestHandler = async (req, res) => {
  res.json(await submitInvoice(getActor(req), invoiceId(req), parseRequestBody(decisionBodySchema, bodyOf(req)).version));
};
const handleApprove: RequestHandler = async (req, res) => {
  res.json(await approveInvoice(getActor(req), invoiceId(req), parseRequestBody(decisionBodySchema, bodyOf(req)).version));
};
const handleReturn: RequestHandler = async (req, res) => {
  res.json(await returnInvoice(getActor(req), invoiceId(req), parseRequestBody(returnBodySchema, req.body)));
};
const handleCancel: RequestHandler = async (req, res) => {
  res.json(await cancelInvoice(getActor(req), invoiceId(req), parseRequestBody(cancelBodySchema, req.body)));
};
const handleReceive: RequestHandler = async (req, res) => {
  res.status(201).json(await receiveInvoicePayment(getActor(req), invoiceId(req), parseRequestBody(receiveBodySchema, req.body)));
};
const handleHistory: RequestHandler = async (req, res) => {
  res.json(await getInvoiceHistory(getActor(req), invoiceId(req), parseRequestQuery(z.object(paginationQueryFields), req.query)));
};

const handleClientAccounts: RequestHandler = async (_req, res) => {
  res.json(await listClientAccounts());
};
const handleClientStatement: RequestHandler = async (req, res) => {
  res.json(await getClientStatement(String(req.params.id)));
};

const BASE = '/accounts/invoices';

/**
 * Client invoices: draft, submitted, issued (owed by the client in the ledger), cancelled. Approve, return and
 * cancel need only read access at the route, because the stand-in approver may decide; the service checks the
 * approve permission or stand-in, and refuses the invoice's maker. Receive payment makes a receipt voucher, so it
 * needs voucher create. Billable tasks reads Project management through its billing helpers.
 */
export const invoiceRoutes: ApiRoute[] = [
  { method: 'GET', path: BASE, access: 'private', permission: 'invoice.read', handler: handleList },
  { method: 'POST', path: BASE, access: 'private', permission: 'invoice.create', bodySchema: createBodySchema, handler: handleCreate },
  { method: 'GET', path: `${BASE}/billable-tasks`, access: 'private', permission: 'invoice.create', handler: handleBillableTasks },
  { method: 'GET', path: `${BASE}/:id`, access: 'private', permission: 'invoice.read', handler: handleGet },
  { method: 'PATCH', path: `${BASE}/:id`, access: 'private', permission: 'invoice.update', bodySchema: updateBodySchema, handler: handleUpdate },
  { method: 'POST', path: `${BASE}/:id/submit`, access: 'private', permission: 'invoice.update', bodySchema: decisionBodySchema, handler: handleSubmit },
  { method: 'POST', path: `${BASE}/:id/approve`, access: 'private', permission: 'invoice.read', bodySchema: decisionBodySchema, handler: handleApprove },
  { method: 'POST', path: `${BASE}/:id/return`, access: 'private', permission: 'invoice.read', bodySchema: returnBodySchema, handler: handleReturn },
  { method: 'POST', path: `${BASE}/:id/cancel`, access: 'private', permission: 'invoice.read', bodySchema: cancelBodySchema, handler: handleCancel },
  { method: 'POST', path: `${BASE}/:id/receive-payment`, access: 'private', permission: 'journalVoucher.create', bodySchema: receiveBodySchema, handler: handleReceive },
  { method: 'GET', path: `${BASE}/:id/history`, access: 'private', permission: 'invoice.read', handler: handleHistory },
  // What each client was billed, paid and owes, and one client's statement: read from invoices and their receipts.
  { method: 'GET', path: '/accounts/client-accounts', access: 'private', permission: 'invoice.read', handler: handleClientAccounts },
  { method: 'GET', path: '/accounts/client-accounts/:id', access: 'private', permission: 'invoice.read', handler: handleClientStatement },
];

/** Invoices waiting for approval, for the Approvals queue. The amount is in taka at the rate on the issue date. */
export const invoiceApprovals: ApprovalSource = {
  type: 'invoice',
  readPermission: 'invoice.read',
  approvePermission: 'invoice.approve',
  async findWaiting(creator, limit) {
    const { invoices, total } = await findSubmittedInvoices(creator, limit);
    const records = await Promise.all(invoices.map(async (invoice) => ({
      id: invoice._id,
      number: invoice.number,
      title: invoice.clientName,
      amount: toPaisa(invoice.total, await rateOn(invoice.currency, invoice.issueDate, 'currency')),
      date: invoice.issueDate,
      createdBy: invoice.createdBy,
      submittedAt: invoice.submittedAt,
    })));
    return { total, records };
  },
};
