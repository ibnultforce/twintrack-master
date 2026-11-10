import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { paginationQueryFields } from '../../../lib/query.js';
import { parseRequestBody, parseRequestQuery } from '../../../lib/validation.js';
import { getActor } from '../../master/access/caller.js';
import { getPermissionScope as scopeOf } from '../../master/access/scope.js';
import { GRANTEE_TYPES, SHARE_ACCESS } from '../../master/models/recordShare.js';
import {
  approveSalary,
  createSalary,
  deleteSalary,
  getSalaryHistory,
  listSalaries,
  listSalaryShares,
  restoreSalary,
  shareSalary,
  unshareSalary,
  updateSalary,
} from './salary.service.js';

const MAX_ID_LENGTH = 100;

const amountField = z.number().positive('must be above zero');
const currencyField = z.string().regex(/^[A-Z]{3}$/, 'must be a three-letter code, such as BDT');
const dateField = z.iso.date('must be a date, such as 2026-12-01').transform((value) => new Date(value));

const versionField = z.number().int().min(0);

const listQuerySchema = z.object({
  ...paginationQueryFields,
  // Query strings carry text, so only the word true asks for the recycle bin.
  deleted: z.enum(['true', 'false']).optional().transform((value) => value === 'true'),
});

const historyQuerySchema = z.object(paginationQueryFields);

const createBodySchema = z.strictObject({
  employeeId: z.string().min(1, 'is required').max(MAX_ID_LENGTH),
  amount: amountField,
  currency: currencyField.optional(),
  effectiveFrom: dateField,
});

const updateBodySchema = z
  .strictObject({ amount: amountField.optional(), currency: currencyField.optional(), effectiveFrom: dateField.optional(), version: versionField.optional() })
  .refine(({ version: _version, ...changes }) => Object.keys(changes).length > 0, { message: 'send at least one field to change' });

const shareBodySchema = z.strictObject({
  granteeType: z.enum(GRANTEE_TYPES),
  granteeId: z.string().min(1, 'is required').max(MAX_ID_LENGTH),
  access: z.enum(SHARE_ACCESS),
  expiresAt: z.iso.datetime('must be a date and time, such as 2027-01-01T00:00:00Z').transform((value) => new Date(value)).optional(),
});

const approveBodySchema = z.strictObject({ version: versionField.optional() });

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
  // A request with no body is an approval without a version check.
  const { version } = parseRequestBody(approveBodySchema, req.body ?? {});
  res.json(await approveSalary(getActor(req), scopeOf(req), String(req.params.id), version));
};

const handleDelete: RequestHandler = async (req, res) => {
  res.json(await deleteSalary(getActor(req), scopeOf(req), String(req.params.id)));
};

const handleRestore: RequestHandler = async (req, res) => {
  res.json(await restoreSalary(getActor(req), scopeOf(req), String(req.params.id)));
};

const handleListShares: RequestHandler = async (req, res) => {
  res.json(await listSalaryShares(getActor(req), scopeOf(req), String(req.params.id)));
};

const handleShare: RequestHandler = async (req, res) => {
  res.status(201).json(await shareSalary(getActor(req), String(req.params.id), parseRequestBody(shareBodySchema, req.body)));
};

const handleUnshare: RequestHandler = async (req, res) => {
  res.json(await unshareSalary(getActor(req), String(req.params.id), String(req.params.shareId)));
};

const handleHistory: RequestHandler = async (req, res) => {
  res.json(await getSalaryHistory(getActor(req), scopeOf(req), String(req.params.id), parseRequestQuery(historyQuerySchema, req.query)));
};

export const salaryRoutes: ApiRoute[] = [
  { method: 'GET', path: '/hr/salaries', access: 'private', permission: 'salary.read', handler: handleList },
  { method: 'POST', path: '/hr/salaries', access: 'private', permission: 'salary.create', handler: handleCreate },
  { method: 'PATCH', path: '/hr/salaries/:id', access: 'private', permission: 'salary.update', handler: handleUpdate },
  { method: 'PATCH', path: '/hr/salaries/:id/approve', access: 'private', permission: 'salary.approve', handler: handleApprove },
  { method: 'DELETE', path: '/hr/salaries/:id', access: 'private', permission: 'salary.delete', handler: handleDelete },
  { method: 'POST', path: '/hr/salaries/:id/restore', access: 'private', permission: 'salary.delete', handler: handleRestore },
  { method: 'GET', path: '/hr/salaries/:id/history', access: 'private', permission: 'salary.read', handler: handleHistory },
  // Sharing needs salary.read to reach these. The service then decides who may share, from the salary and its owner.
  { method: 'GET', path: '/hr/salaries/:id/shares', access: 'private', permission: 'salary.read', handler: handleListShares },
  { method: 'POST', path: '/hr/salaries/:id/shares', access: 'private', permission: 'salary.read', handler: handleShare },
  { method: 'DELETE', path: '/hr/salaries/:id/shares/:shareId', access: 'private', permission: 'salary.read', handler: handleUnshare },
];
