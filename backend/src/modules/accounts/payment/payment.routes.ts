import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { paginationQueryFields } from '../../../lib/query.js';
import { parseRequestBody, parseRequestQuery } from '../../../lib/validation.js';
import { getActor } from '../../master/access/caller.js';
import { dateField, idField, methodField, nameField, positiveMoneyField, requiredTextField, shortTextField, textField } from '../accountsFields.js';
import { PAYEE_TYPES } from '../models/money.js';
import { createPayment, getPayment, listPayments, reversePayment } from './payment.service.js';

const listQuerySchema = z.object({
  ...paginationQueryFields,
  bankAccountId: idField.optional(),
  billId: idField.optional(),
  payeeVendorId: idField.optional(),
  payeeUserId: idField.optional(),
  from: dateField.optional(),
  to: dateField.optional(),
});
const createBodySchema = z.strictObject({
  bankAccountId: idField,
  billId: idField.optional(),
  categoryId: idField.optional(),
  projectId: idField.optional(),
  department: shortTextField.optional(),
  payeeType: z.enum(PAYEE_TYPES),
  // Only the one the payee type names is used. A bill's vendor is taken from the bill when left out.
  payeeVendorId: idField.optional(),
  payeeUserId: idField.optional(),
  payeeName: nameField.optional(),
  amount: positiveMoneyField,
  paymentDate: dateField,
  method: methodField,
  reference: shortTextField.optional(),
  notes: textField.optional(),
});
const reasonBodySchema = z.strictObject({ reason: requiredTextField });

const id = (params: Record<string, unknown>) => String(params.id);

const handleList: RequestHandler = async (req, res) => {
  res.json(await listPayments(getActor(req), parseRequestQuery(listQuerySchema, req.query)));
};
const handleGet: RequestHandler = async (req, res) => {
  res.json(await getPayment(getActor(req), id(req.params)));
};
const handleCreate: RequestHandler = async (req, res) => {
  res.status(201).json(await createPayment(getActor(req), parseRequestBody(createBodySchema, req.body)));
};
const handleReverse: RequestHandler = async (req, res) => {
  res.status(201).json(await reversePayment(getActor(req), id(req.params), parseRequestBody(reasonBodySchema, req.body).reason));
};

/** Money out. Posted payments are never edited or deleted, only reversed. */
export const paymentRoutes: ApiRoute[] = [
  { method: 'GET', path: '/accounts/payments', access: 'private', permission: 'payment.read', handler: handleList },
  { method: 'POST', path: '/accounts/payments', access: 'private', permission: 'payment.create', handler: handleCreate },
  { method: 'GET', path: '/accounts/payments/:id', access: 'private', permission: 'payment.read', handler: handleGet },
  { method: 'POST', path: '/accounts/payments/:id/reverse', access: 'private', permission: 'payment.delete', handler: handleReverse },
];
