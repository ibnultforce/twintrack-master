import type { Request, RequestHandler } from 'express';
import { z } from 'zod';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { paginationQueryFields } from '../../../lib/query.js';
import { parseRequestBody, parseRequestQuery } from '../../../lib/validation.js';
import { getActor } from '../../master/access/caller.js';
import { financialYearQuerySchema, minorUnitsField, monthField, recordIdField, versionField } from '../accountsFields.js';
import { REGULAR_EXPENSE_CATEGORIES, REGULAR_EXPENSE_FREQUENCIES } from '../models/regularExpense.js';
import {
  createRegularExpense,
  getOfficeRent,
  getRegularExpenseHistory,
  listRegularExpenses,
  makeRegularExpenseBills,
  updateRegularExpense,
} from './regularExpense.service.js';

/** Every month has a 28th, so a bill dated on that day always exists. */
const LAST_SAFE_DAY = 28;

const vatCodeField = z.string().trim().min(1).max(20);

const detailFields = {
  name: z.string().trim().min(1, 'is required').max(200),
  category: z.enum(REGULAR_EXPENSE_CATEGORIES),
  vendorId: recordIdField,
  accountId: recordIdField,
  frequency: z.enum(REGULAR_EXPENSE_FREQUENCIES),
  amount: minorUnitsField.min(1, 'must be above zero'),
  dayOfMonth: z.number().int().min(1).max(LAST_SAFE_DAY, `must be 1 to ${LAST_SAFE_DAY}, so every month has it`),
  startMonth: monthField,
};

const createBodySchema = z.strictObject({ ...detailFields, vatCode: vatCodeField.optional(), endMonth: monthField.optional() });

const updateBodySchema = z
  .strictObject({
    name: detailFields.name.optional(),
    category: detailFields.category.optional(),
    vendorId: detailFields.vendorId.optional(),
    accountId: detailFields.accountId.optional(),
    frequency: detailFields.frequency.optional(),
    amount: detailFields.amount.optional(),
    dayOfMonth: detailFields.dayOfMonth.optional(),
    startMonth: detailFields.startMonth.optional(),
    // null removes them.
    vatCode: vatCodeField.nullable().optional(),
    endMonth: monthField.nullable().optional(),
    isActive: z.boolean().optional(),
    version: versionField.optional(),
  })
  .refine(({ version: _version, ...changes }) => Object.keys(changes).length > 0, { message: 'send at least one field to change' });

const listQuerySchema = z.object({
  category: z.enum(REGULAR_EXPENSE_CATEGORIES).optional(),
  isActive: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
});
const makeBillsBodySchema = z.strictObject({ month: monthField });

const idOf = (req: Request) => String(req.params.id);

const handleList: RequestHandler = async (req, res) => {
  res.json(await listRegularExpenses(parseRequestQuery(listQuerySchema, req.query)));
};
const handleCreate: RequestHandler = async (req, res) => {
  res.status(201).json(await createRegularExpense(getActor(req), parseRequestBody(createBodySchema, req.body)));
};
const handleUpdate: RequestHandler = async (req, res) => {
  res.json(await updateRegularExpense(getActor(req), idOf(req), parseRequestBody(updateBodySchema, req.body)));
};
const handleHistory: RequestHandler = async (req, res) => {
  res.json(await getRegularExpenseHistory(idOf(req), parseRequestQuery(z.object(paginationQueryFields), req.query)));
};
const handleMakeBills: RequestHandler = async (req, res) => {
  res.json(await makeRegularExpenseBills(getActor(req), parseRequestBody(makeBillsBodySchema, req.body).month));
};
const handleOfficeRent: RequestHandler = async (req, res) => {
  res.json(await getOfficeRent(getActor(req), parseRequestQuery(financialYearQuerySchema, req.query).year));
};

const BASE = '/accounts/regular-expenses';

/**
 * Regular expenses, which make one draft bill per period that someone approves (decision 4), and the Office rent
 * screen, which shows the rent ones with their bills. Making bills needs the bill create permission, as bills do.
 */
export const regularExpenseRoutes: ApiRoute[] = [
  { method: 'GET', path: BASE, access: 'private', permission: 'regularExpense.read', handler: handleList },
  { method: 'POST', path: BASE, access: 'private', permission: 'regularExpense.create', bodySchema: createBodySchema, handler: handleCreate },
  { method: 'POST', path: `${BASE}/bills`, access: 'private', permission: 'bill.create', bodySchema: makeBillsBodySchema, handler: handleMakeBills },
  { method: 'PATCH', path: `${BASE}/:id`, access: 'private', permission: 'regularExpense.update', bodySchema: updateBodySchema, handler: handleUpdate },
  { method: 'GET', path: `${BASE}/:id/history`, access: 'private', permission: 'regularExpense.read', handler: handleHistory },
  { method: 'GET', path: '/accounts/office-rent', access: 'private', permission: 'bill.read', handler: handleOfficeRent },
];
