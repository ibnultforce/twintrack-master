import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { paginationQueryFields } from '../../../lib/query.js';
import { parseRequestBody, parseRequestQuery } from '../../../lib/validation.js';
import { getActor } from '../../master/access/caller.js';
import { idField, moneyField, requiredTextField, shortTextField, textField, versionField, yearField } from '../accountsFields.js';
import { PAYROLL_RUN_STATUSES, SETTLEMENT_STATUSES } from '../models/payroll.js';
import {
  approvePayrollRun,
  createPayrollRun,
  deletePayrollRun,
  getPayrollRun,
  getPayrollRunHistory,
  listPayrollRuns,
  returnPayrollRun,
  settlePayrollItem,
  submitPayrollRun,
  updatePayrollRun,
} from './payroll.service.js';

const MAX_PEOPLE = 2000;

const listQuerySchema = z.object({ ...paginationQueryFields, year: yearField.optional(), status: z.enum(PAYROLL_RUN_STATUSES).optional() });
const pageQuerySchema = z.object(paginationQueryFields);
const createBodySchema = z.strictObject({
  month: z.number().int().min(1).max(12),
  year: z.number().int().min(2000).max(2100),
  // Missing means everyone active with an approved salary for the month.
  userIds: z.array(idField).min(1).max(MAX_PEOPLE).optional(),
  bankAccountId: idField.optional(),
  notes: textField.optional(),
});
const updateBodySchema = z
  .strictObject({
    notes: textField.optional(),
    bankAccountId: idField.optional(),
    deductions: z.array(z.strictObject({ itemId: idField, amount: moneyField })).max(MAX_PEOPLE).optional(),
    version: versionField.optional(),
  })
  .refine(({ version: _version, ...changes }) => Object.keys(changes).length > 0, { message: 'send at least one field to change' });
const reasonBodySchema = z.strictObject({ reason: requiredTextField });
const settleBodySchema = z.strictObject({ settlementStatus: z.enum(SETTLEMENT_STATUSES), reference: shortTextField.optional(), notes: textField.optional(), version: versionField.optional() });

const id = (params: Record<string, unknown>) => String(params.id);

const handleList: RequestHandler = async (req, res) => {
  res.json(await listPayrollRuns(getActor(req), parseRequestQuery(listQuerySchema, req.query)));
};
const handleGet: RequestHandler = async (req, res) => {
  res.json(await getPayrollRun(getActor(req), id(req.params)));
};
const handleCreate: RequestHandler = async (req, res) => {
  res.status(201).json(await createPayrollRun(getActor(req), parseRequestBody(createBodySchema, req.body)));
};
const handleUpdate: RequestHandler = async (req, res) => {
  res.json(await updatePayrollRun(getActor(req), id(req.params), parseRequestBody(updateBodySchema, req.body)));
};
const handleSubmit: RequestHandler = async (req, res) => {
  res.json(await submitPayrollRun(getActor(req), id(req.params)));
};
const handleApprove: RequestHandler = async (req, res) => {
  res.json(await approvePayrollRun(getActor(req), id(req.params)));
};
const handleReturn: RequestHandler = async (req, res) => {
  res.json(await returnPayrollRun(getActor(req), id(req.params), parseRequestBody(reasonBodySchema, req.body).reason));
};
const handleDelete: RequestHandler = async (req, res) => {
  await deletePayrollRun(getActor(req), id(req.params));
  res.status(204).end();
};
const handleSettle: RequestHandler = async (req, res) => {
  res.json(await settlePayrollItem(getActor(req), id(req.params), String(req.params.itemId), parseRequestBody(settleBodySchema, req.body)));
};
const handleHistory: RequestHandler = async (req, res) => {
  res.json(await getPayrollRunHistory(getActor(req), id(req.params), parseRequestQuery(pageQuerySchema, req.query)));
};

/** Monthly payroll from HR salaries and Tasks incentives: drafted, approved by someone else, then paid person by person. */
export const payrollRoutes: ApiRoute[] = [
  { method: 'GET', path: '/accounts/payroll-runs', access: 'private', permission: 'payrollRun.read', handler: handleList },
  { method: 'POST', path: '/accounts/payroll-runs', access: 'private', permission: 'payrollRun.create', handler: handleCreate },
  { method: 'GET', path: '/accounts/payroll-runs/:id', access: 'private', permission: 'payrollRun.read', handler: handleGet },
  { method: 'PATCH', path: '/accounts/payroll-runs/:id', access: 'private', permission: 'payrollRun.update', handler: handleUpdate },
  { method: 'DELETE', path: '/accounts/payroll-runs/:id', access: 'private', permission: 'payrollRun.delete', handler: handleDelete },
  { method: 'POST', path: '/accounts/payroll-runs/:id/submit', access: 'private', permission: 'payrollRun.update', handler: handleSubmit },
  { method: 'POST', path: '/accounts/payroll-runs/:id/approve', access: 'private', permission: 'payrollRun.approve', handler: handleApprove },
  { method: 'POST', path: '/accounts/payroll-runs/:id/return', access: 'private', permission: 'payrollRun.approve', handler: handleReturn },
  { method: 'PATCH', path: '/accounts/payroll-runs/:id/items/:itemId', access: 'private', permission: 'payrollRun.update', handler: handleSettle },
  { method: 'GET', path: '/accounts/payroll-runs/:id/history', access: 'private', permission: 'payrollRun.read', handler: handleHistory },
];
