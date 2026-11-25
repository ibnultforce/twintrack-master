import type { Request, RequestHandler } from 'express';
import { z } from 'zod';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { paginationQueryFields } from '../../../lib/query.js';
import { parseRequestBody, parseRequestQuery } from '../../../lib/validation.js';
import { getActor } from '../../master/access/caller.js';
import { accountingDateField, minorUnitsField, recordIdField, versionField } from '../accountsFields.js';
import { PAYMENT_STATUSES } from '../documents/documentState.js';
import { BILL_STATUSES } from '../models/bill.js';
import type { ApprovalSource } from '../approvals/approvalQueue.service.js';
import {
  approveBill,
  cancelBill,
  createBill,
  findSubmittedBills,
  getBill,
  getBillHistory,
  listBills,
  payBill,
  returnBill,
  submitBill,
  updateBill,
} from './bill.service.js';

const MAX_LINES = 200;
const MAX_TEXT = 500;
const MAX_NOTE = 1000;
/** A thousand of anything with three decimals is plenty for an office bill; more is almost surely a typing mistake. */
const MAX_QUANTITY = 1_000_000;

const lineSchema = z.strictObject({
  description: z.string().trim().min(1, 'is required').max(MAX_TEXT),
  accountId: recordIdField,
  quantity: z.number().positive('must be above zero').max(MAX_QUANTITY).refine((quantity) => Number.isInteger(quantity * 1000), 'may have up to 3 decimals'),
  unitPrice: minorUnitsField,
});
const linesField = z.array(lineSchema).min(1, 'needs at least 1 line').max(MAX_LINES);
const referenceField = z.string().trim().max(100);
const reasonField = z.string().trim().min(1, 'say why').max(MAX_NOTE);
/** A tax rate code from Settings, such as VAT15. */
const vatCodeField = z.string().trim().min(1).max(20);

const createBodySchema = z
  .strictObject({ vendorId: recordIdField, vendorReference: referenceField.optional(), billDate: accountingDateField, dueDate: accountingDateField.optional(), lines: linesField, vatCode: vatCodeField.optional() })
  .refine(({ billDate, dueDate }) => !dueDate || dueDate >= billDate, { message: 'must be on or after the bill date', path: ['dueDate'] });

const updateBodySchema = z
  .strictObject({
    vendorId: recordIdField.optional(),
    // Empty removes it.
    vendorReference: referenceField.optional(),
    billDate: accountingDateField.optional(),
    dueDate: accountingDateField.optional(),
    lines: linesField.optional(),
    // null removes the VAT.
    vatCode: vatCodeField.nullable().optional(),
    reason: reasonField,
    version: versionField.optional(),
  })
  .refine(({ version: _version, reason: _reason, ...changes }) => Object.keys(changes).length > 0, { message: 'send at least one field to change' });

const decisionBodySchema = z.strictObject({ version: versionField.optional() });
const returnBodySchema = z.strictObject({ note: z.string().trim().min(1, 'say what needs fixing').max(MAX_NOTE), version: versionField.optional() });
const cancelBodySchema = z.strictObject({ reason: reasonField, version: versionField.optional() });
const payBodySchema = z.strictObject({
  paymentDate: accountingDateField,
  moneyAccountId: recordIdField,
  // Leave out to pay everything still open.
  amount: minorUnitsField.min(1, 'must be above zero').optional(),
  reference: referenceField.optional(),
});

const listQuerySchema = z
  .object({
    ...paginationQueryFields,
    status: z.enum(BILL_STATUSES).optional(),
    paymentStatus: z.enum(PAYMENT_STATUSES).optional(),
    vendorId: recordIdField.optional(),
    from: accountingDateField.optional(),
    to: accountingDateField.optional(),
    search: z.string().trim().max(100).optional().transform((text) => text || undefined),
  })
  .refine(({ from, to }) => !from || !to || from <= to, { message: 'from must be on or before to', path: ['to'] });

const billId = (req: Request) => String(req.params.id);
const bodyOf = (req: Request) => req.body ?? {};

const handleList: RequestHandler = async (req, res) => {
  res.json(await listBills(getActor(req), parseRequestQuery(listQuerySchema, req.query)));
};
const handleGet: RequestHandler = async (req, res) => {
  res.json(await getBill(getActor(req), billId(req)));
};
const handleCreate: RequestHandler = async (req, res) => {
  res.status(201).json(await createBill(getActor(req), parseRequestBody(createBodySchema, req.body)));
};
const handleUpdate: RequestHandler = async (req, res) => {
  res.json(await updateBill(getActor(req), billId(req), parseRequestBody(updateBodySchema, req.body)));
};
const handleSubmit: RequestHandler = async (req, res) => {
  res.json(await submitBill(getActor(req), billId(req), parseRequestBody(decisionBodySchema, bodyOf(req)).version));
};
const handleApprove: RequestHandler = async (req, res) => {
  res.json(await approveBill(getActor(req), billId(req), parseRequestBody(decisionBodySchema, bodyOf(req)).version));
};
const handleReturn: RequestHandler = async (req, res) => {
  res.json(await returnBill(getActor(req), billId(req), parseRequestBody(returnBodySchema, req.body)));
};
const handleCancel: RequestHandler = async (req, res) => {
  res.json(await cancelBill(getActor(req), billId(req), parseRequestBody(cancelBodySchema, req.body)));
};
const handlePay: RequestHandler = async (req, res) => {
  res.status(201).json(await payBill(getActor(req), billId(req), parseRequestBody(payBodySchema, req.body)));
};
const handleHistory: RequestHandler = async (req, res) => {
  res.json(await getBillHistory(getActor(req), billId(req), parseRequestQuery(z.object(paginationQueryFields), req.query)));
};

const BASE = '/accounts/bills';

/**
 * Vendor bills: draft, submitted, recorded (owed to the vendor in the ledger), cancelled. Approve, return and cancel
 * need only read access at the route, because the stand-in approver may decide; the service checks the approve
 * permission or stand-in, and refuses the bill's maker. Pay makes a payment voucher, so it needs voucher create.
 */
export const billRoutes: ApiRoute[] = [
  { method: 'GET', path: BASE, access: 'private', permission: 'bill.read', handler: handleList },
  { method: 'POST', path: BASE, access: 'private', permission: 'bill.create', bodySchema: createBodySchema, handler: handleCreate },
  { method: 'GET', path: `${BASE}/:id`, access: 'private', permission: 'bill.read', handler: handleGet },
  { method: 'PATCH', path: `${BASE}/:id`, access: 'private', permission: 'bill.update', bodySchema: updateBodySchema, handler: handleUpdate },
  { method: 'POST', path: `${BASE}/:id/submit`, access: 'private', permission: 'bill.update', bodySchema: decisionBodySchema, handler: handleSubmit },
  { method: 'POST', path: `${BASE}/:id/approve`, access: 'private', permission: 'bill.read', bodySchema: decisionBodySchema, handler: handleApprove },
  { method: 'POST', path: `${BASE}/:id/return`, access: 'private', permission: 'bill.read', bodySchema: returnBodySchema, handler: handleReturn },
  { method: 'POST', path: `${BASE}/:id/cancel`, access: 'private', permission: 'bill.read', bodySchema: cancelBodySchema, handler: handleCancel },
  { method: 'POST', path: `${BASE}/:id/pay`, access: 'private', permission: 'journalVoucher.create', bodySchema: payBodySchema, handler: handlePay },
  { method: 'GET', path: `${BASE}/:id/history`, access: 'private', permission: 'bill.read', handler: handleHistory },
];

/** Bills waiting for approval, for the Approvals queue. */
export const billApprovals: ApprovalSource = {
  type: 'bill',
  readPermission: 'bill.read',
  approvePermission: 'bill.approve',
  async findWaiting(creator, limit) {
    const { bills, total } = await findSubmittedBills(creator, limit);
    return {
      total,
      records: bills.map((bill) => ({
        id: bill._id,
        number: bill.number,
        title: bill.vendorName,
        amount: bill.amount,
        date: bill.billDate,
        createdBy: bill.createdBy,
        submittedAt: bill.submittedAt,
      })),
    };
  },
};
