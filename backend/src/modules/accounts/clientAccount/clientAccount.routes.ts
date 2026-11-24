import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { parseRequestBody } from '../../../lib/validation.js';
import { getActor } from '../../master/access/caller.js';
import { minorUnitsField, versionField } from '../accountsFields.js';
import { listClientAccounts, updateClientAccount } from './clientAccount.service.js';

/** Payment terms longer than this are almost certainly a typing mistake. */
const MAX_TERMS_DAYS = 365;

const updateBodySchema = z
  .strictObject({
    termsDays: z.number().int('must be whole days').min(0).max(MAX_TERMS_DAYS).optional(),
    currency: z.string().trim().regex(/^[A-Z]{3,10}$/, 'must be a currency code, such as BDT or USD').optional(),
    // null clears the rate.
    hourlyRate: minorUnitsField.min(1, 'must be above zero').nullable().optional(),
    version: versionField.optional(),
  })
  .refine(({ version: _version, ...changes }) => Object.keys(changes).length > 0, { message: 'send at least one field to change' });

const handleList: RequestHandler = async (req, res) => {
  res.json(await listClientAccounts(getActor(req)));
};
const handleUpdate: RequestHandler = async (req, res) => {
  res.json(await updateClientAccount(getActor(req), String(req.params.id), parseRequestBody(updateBodySchema, req.body)));
};

/** How each active Master client is billed: payment terms, currency and hourly rate. The client itself stays in Master. */
export const clientAccountRoutes: ApiRoute[] = [
  { method: 'GET', path: '/accounts/clients', access: 'private', permission: 'clientAccount.read', handler: handleList },
  { method: 'PATCH', path: '/accounts/clients/:id', access: 'private', permission: 'clientAccount.update', bodySchema: updateBodySchema, handler: handleUpdate },
];
