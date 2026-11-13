import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { paginationQueryFields } from '../../../lib/query.js';
import { parseRequestBody, parseRequestQuery } from '../../../lib/validation.js';
import { getActor } from '../../master/access/caller.js';
import {
  changesSomething,
  changesSomethingMessage,
  currencyField,
  dateField,
  idField,
  positiveMoneyField,
  requiredTextField,
  shortTextField,
  textField,
  versionField,
} from '../accountsFields.js';
import { BILL_STATUSES } from '../models/money.js';
import { approveBill, createBill, deleteBill, getBill, getBillHistory, listBills, rejectBill, reverseBill, submitBill, updateBill } from './bill.service.js';

const yesNoQuery = z.enum(['true', 'false']).optional().transform((value) => (value === undefined ? undefined : value === 'true'));

const detailFields = {
  billNumber: shortTextField.optional(),
  categoryId: idField.optional(),
  projectId: idField.optional(),
  department: shortTextField.optional(),
  dueDate: dateField.optional(),
  taxCode: shortTextField.optional(),
  notes: textField.optional(),
};

const listQuerySchema = z.object({
  ...paginationQueryFields,
  status: z.enum(BILL_STATUSES).optional(),
  vendorId: idField.optional(),
  projectId: idField.optional(),
  categoryId: idField.optional(),
  overdue: yesNoQuery,
});
const pageQuerySchema = z.object(paginationQueryFields);
const createBodySchema = z.strictObject({ vendorId: idField, businessDate: dateField, currency: currencyField, amount: positiveMoneyField, ...detailFields });
const updateBodySchema = z
  .strictObject({ vendorId: idField.optional(), businessDate: dateField.optional(), currency: currencyField.optional(), amount: positiveMoneyField.optional(), ...detailFields, version: versionField.optional() })
  .refine(changesSomething, changesSomethingMessage);
const reasonBodySchema = z.strictObject({ reason: requiredTextField });

const id = (params: Record<string, unknown>) => String(params.id);

const handleList: RequestHandler = async (req, res) => {
  res.json(await listBills(getActor(req), parseRequestQuery(listQuerySchema, req.query)));
};
const handleGet: RequestHandler = async (req, res) => {
  res.json(await getBill(getActor(req), id(req.params)));
};
const handleCreate: RequestHandler = async (req, res) => {
  res.status(201).json(await createBill(getActor(req), parseRequestBody(createBodySchema, req.body)));
};
const handleUpdate: RequestHandler = async (req, res) => {
  res.json(await updateBill(getActor(req), id(req.params), parseRequestBody(updateBodySchema, req.body)));
};
const handleSubmit: RequestHandler = async (req, res) => {
  res.json(await submitBill(getActor(req), id(req.params)));
};
const handleApprove: RequestHandler = async (req, res) => {
  res.json(await approveBill(getActor(req), id(req.params)));
};
const handleReject: RequestHandler = async (req, res) => {
  res.json(await rejectBill(getActor(req), id(req.params), parseRequestBody(reasonBodySchema, req.body).reason));
};
const handleReverse: RequestHandler = async (req, res) => {
  res.json(await reverseBill(getActor(req), id(req.params), parseRequestBody(reasonBodySchema, req.body).reason));
};
const handleDelete: RequestHandler = async (req, res) => {
  await deleteBill(getActor(req), id(req.params));
  res.status(204).end();
};
const handleHistory: RequestHandler = async (req, res) => {
  res.json(await getBillHistory(getActor(req), id(req.params), parseRequestQuery(pageQuerySchema, req.query)));
};

/** Bills from vendors: drafted, sent for approval, approved or rejected by someone else, paid, and reversed if wrong. */
export const billRoutes: ApiRoute[] = [
  { method: 'GET', path: '/accounts/bills', access: 'private', permission: 'bill.read', handler: handleList },
  { method: 'POST', path: '/accounts/bills', access: 'private', permission: 'bill.create', handler: handleCreate },
  { method: 'GET', path: '/accounts/bills/:id', access: 'private', permission: 'bill.read', handler: handleGet },
  { method: 'PATCH', path: '/accounts/bills/:id', access: 'private', permission: 'bill.update', handler: handleUpdate },
  { method: 'DELETE', path: '/accounts/bills/:id', access: 'private', permission: 'bill.delete', handler: handleDelete },
  { method: 'POST', path: '/accounts/bills/:id/submit', access: 'private', permission: 'bill.update', handler: handleSubmit },
  { method: 'POST', path: '/accounts/bills/:id/approve', access: 'private', permission: 'bill.approve', handler: handleApprove },
  { method: 'POST', path: '/accounts/bills/:id/reject', access: 'private', permission: 'bill.approve', handler: handleReject },
  { method: 'POST', path: '/accounts/bills/:id/reverse', access: 'private', permission: 'bill.delete', handler: handleReverse },
  { method: 'GET', path: '/accounts/bills/:id/history', access: 'private', permission: 'bill.read', handler: handleHistory },
];
