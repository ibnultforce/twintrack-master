import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { parseRequestBody, parseRequestQuery } from '../../../lib/validation.js';
import { getActor } from '../../master/access/caller.js';
import { minorUnitsField, recordIdField, versionField } from '../accountsFields.js';
import { getBudget, setBudget } from './budget.service.js';

/** More lines than the chart has expense accounts is a mistake. */
const MAX_LINES = 200;

const yearParamSchema = z.object({ year: z.coerce.number().int().min(2000).max(2100) });
const setBodySchema = z.strictObject({
  lines: z.array(z.strictObject({ accountId: recordIdField, amount: minorUnitsField })).max(MAX_LINES),
  version: versionField.optional(),
});

const yearOf = (params: unknown) => parseRequestQuery(yearParamSchema, params).year;

const handleGet: RequestHandler = async (req, res) => {
  res.json(await getBudget(yearOf(req.params)));
};
const handleSet: RequestHandler = async (req, res) => {
  res.json(await setBudget(getActor(req), yearOf(req.params), parseRequestBody(setBodySchema, req.body)));
};

/**
 * A financial year's budget against actual spending. Who may change the budget comes from profiles (budget.update):
 * the specification gives it to the CEO only, which is a profile choice, not code.
 */
export const budgetRoutes: ApiRoute[] = [
  { method: 'GET', path: '/accounts/budgets/:year', access: 'private', permission: 'budget.read', handler: handleGet },
  { method: 'PUT', path: '/accounts/budgets/:year', access: 'private', permission: 'budget.update', bodySchema: setBodySchema, handler: handleSet },
];
