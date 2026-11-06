import type { Request, RequestHandler } from 'express';
import { z } from 'zod';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { paginationQueryFields } from '../../../lib/query.js';
import { parseRequestBody, parseRequestQuery } from '../../../lib/validation.js';
import { getActor } from '../../master/access/caller.js';
import { approveSalary, createSalary, listSalaries, updateSalary } from './salary.service.js';

const MAX_ID_LENGTH = 100;

const amountField = z.number().positive('must be above zero');
const currencyField = z.string().regex(/^[A-Z]{3}$/, 'must be a three-letter code, such as BDT');
const dateField = z.iso.date('must be a date, such as 2026-12-01').transform((value) => new Date(value));

const listQuerySchema = z.object(paginationQueryFields);

const createBodySchema = z.strictObject({
  employeeId: z.string().min(1, 'is required').max(MAX_ID_LENGTH),
  amount: amountField,
  currency: currencyField.optional(),
  effectiveFrom: dateField,
});

const updateBodySchema = z
  .strictObject({ amount: amountField.optional(), currency: currencyField.optional(), effectiveFrom: dateField.optional() })
  .refine((changes) => Object.keys(changes).length > 0, { message: 'send at least one field to change' });

/** Set by the permission check on these routes: how far this person's permission reaches. */
function scopeOf(req: Request) {
  if (!req.permissionScope) throw new Error(`${req.method} ${req.path} used the scope without a permission check.`);
  return req.permissionScope;
}

const handleList: RequestHandler = async (req, res) => {
  res.json(await listSalaries(getActor(req), scopeOf(req), parseRequestQuery(listQuerySchema, req.query)));
};

const handleCreate: RequestHandler = async (req, res) => {
  const details = parseRequestBody(createBodySchema, req.body);
  res.status(201).json(await createSalary(getActor(req), scopeOf(req), details));
};

const handleUpdate: RequestHandler = async (req, res) => {
  const changes = parseRequestBody(updateBodySchema, req.body);
  res.json(await updateSalary(getActor(req), scopeOf(req), String(req.params.id), changes));
};

const handleApprove: RequestHandler = async (req, res) => {
  res.json(await approveSalary(getActor(req), scopeOf(req), String(req.params.id)));
};

export const salaryRoutes: ApiRoute[] = [
  { method: 'GET', path: '/hr/salaries', access: 'private', permission: 'salary.read', handler: handleList },
  { method: 'POST', path: '/hr/salaries', access: 'private', permission: 'salary.create', handler: handleCreate },
  { method: 'PATCH', path: '/hr/salaries/:id', access: 'private', permission: 'salary.update', handler: handleUpdate },
  { method: 'PATCH', path: '/hr/salaries/:id/approve', access: 'private', permission: 'salary.approve', handler: handleApprove },
];
