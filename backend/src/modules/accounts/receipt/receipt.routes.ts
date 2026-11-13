import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { paginationQueryFields } from '../../../lib/query.js';
import { parseRequestBody, parseRequestQuery } from '../../../lib/validation.js';
import { getActor } from '../../master/access/caller.js';
import { dateField, idField, methodField, moneyField, positiveMoneyField, requiredTextField, shortTextField, textField, versionField } from '../accountsFields.js';
import { allocateReceipt, createReceipt, getReceipt, listReceipts, removeAllocation, reverseReceipt } from './receipt.service.js';

const listQuerySchema = z.object({
  ...paginationQueryFields,
  bankAccountId: idField.optional(),
  clientId: idField.optional(),
  from: dateField.optional(),
  to: dateField.optional(),
});
const createBodySchema = z.strictObject({
  bankAccountId: idField,
  clientId: idField.optional(),
  amount: positiveMoneyField,
  bankFee: moneyField.optional(),
  receivedDate: dateField,
  method: methodField,
  reference: shortTextField.optional(),
  notes: textField.optional(),
});
const allocateBodySchema = z.strictObject({ invoiceId: idField, amount: positiveMoneyField, version: versionField.optional() });
const reasonBodySchema = z.strictObject({ reason: requiredTextField });

const id = (params: Record<string, unknown>) => String(params.id);

const handleList: RequestHandler = async (req, res) => {
  res.json(await listReceipts(getActor(req), parseRequestQuery(listQuerySchema, req.query)));
};
const handleGet: RequestHandler = async (req, res) => {
  res.json(await getReceipt(getActor(req), id(req.params)));
};
const handleCreate: RequestHandler = async (req, res) => {
  res.status(201).json(await createReceipt(getActor(req), parseRequestBody(createBodySchema, req.body)));
};
const handleAllocate: RequestHandler = async (req, res) => {
  res.json(await allocateReceipt(getActor(req), id(req.params), parseRequestBody(allocateBodySchema, req.body)));
};
const handleRemoveAllocation: RequestHandler = async (req, res) => {
  res.json(await removeAllocation(getActor(req), id(req.params), String(req.params.allocationId)));
};
const handleReverse: RequestHandler = async (req, res) => {
  res.status(201).json(await reverseReceipt(getActor(req), id(req.params), parseRequestBody(reasonBodySchema, req.body).reason));
};

/** Money in, counted against invoices. Posted receipts are never edited or deleted, only reversed. */
export const receiptRoutes: ApiRoute[] = [
  { method: 'GET', path: '/accounts/receipts', access: 'private', permission: 'receipt.read', handler: handleList },
  { method: 'POST', path: '/accounts/receipts', access: 'private', permission: 'receipt.create', handler: handleCreate },
  { method: 'GET', path: '/accounts/receipts/:id', access: 'private', permission: 'receipt.read', handler: handleGet },
  { method: 'POST', path: '/accounts/receipts/:id/allocations', access: 'private', permission: 'receipt.update', handler: handleAllocate },
  { method: 'DELETE', path: '/accounts/receipts/:id/allocations/:allocationId', access: 'private', permission: 'receipt.update', handler: handleRemoveAllocation },
  { method: 'POST', path: '/accounts/receipts/:id/reverse', access: 'private', permission: 'receipt.delete', handler: handleReverse },
];
