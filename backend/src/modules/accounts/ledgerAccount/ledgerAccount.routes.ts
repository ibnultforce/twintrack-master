import type { Request, RequestHandler } from 'express';
import { z } from 'zod';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { paginationQueryFields } from '../../../lib/query.js';
import { parseRequestBody, parseRequestQuery } from '../../../lib/validation.js';
import { getActor } from '../../master/access/caller.js';
import { LEDGER_ACCOUNT_TYPES } from '../models/ledgerAccount.js';
import { ACCOUNT_CODE_MESSAGE, ACCOUNT_CODE_PATTERN } from './ledgerAccountFields.js';
import { createLedgerAccount, getLedgerAccount, getLedgerAccountHistory, listLedgerAccounts, updateLedgerAccount } from './ledgerAccount.service.js';

const MAX_ID_LENGTH = 100;
const MAX_NAME_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 1000;
const MAX_SEARCH_LENGTH = 100;

const codeField = z.string().trim().regex(ACCOUNT_CODE_PATTERN, ACCOUNT_CODE_MESSAGE);
const nameField = z.string().trim().min(1, 'is required').max(MAX_NAME_LENGTH);
const typeField = z.enum(LEDGER_ACCOUNT_TYPES);
const accountIdField = z.string().min(1, 'is required').max(MAX_ID_LENGTH);
const descriptionField = z.string().trim().max(MAX_DESCRIPTION_LENGTH);
const versionField = z.number().int().min(0);
/** Letters, digits, spaces and hyphens, as banks print them; IBANs are at most 34 characters. */
const bankAccountNumberField = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9 -]{2,33}$/, 'must be 3 to 34 letters, digits, spaces or hyphens');

const listQuerySchema = z.object({
  ...paginationQueryFields,
  type: typeField.optional(),
  isActive: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
  search: z.string().trim().min(1).max(MAX_SEARCH_LENGTH).optional(),
});

const createBodySchema = z.strictObject({
  code: codeField,
  name: nameField,
  type: typeField,
  parentId: accountIdField.optional(),
  description: descriptionField.optional(),
  bankAccountNumber: bankAccountNumberField.optional(),
});

const updateBodySchema = z
  .strictObject({
    code: codeField.optional(),
    name: nameField.optional(),
    type: typeField.optional(),
    // null makes it a top-level account.
    parentId: accountIdField.nullable().optional(),
    description: descriptionField.optional(),
    bankAccountNumber: bankAccountNumberField.nullable().optional(),
    isActive: z.boolean().optional(),
    version: versionField.optional(),
  })
  .refine(({ version: _version, ...changes }) => Object.keys(changes).length > 0, { message: 'send at least one field to change' });

const accountId = (req: Request) => String(req.params.id);

const handleList: RequestHandler = async (req, res) => {
  res.json(await listLedgerAccounts(getActor(req), parseRequestQuery(listQuerySchema, req.query)));
};

const handleGet: RequestHandler = async (req, res) => {
  res.json(await getLedgerAccount(getActor(req), accountId(req)));
};

const handleCreate: RequestHandler = async (req, res) => {
  res.status(201).json(await createLedgerAccount(getActor(req), parseRequestBody(createBodySchema, req.body)));
};

const handleHistory: RequestHandler = async (req, res) => {
  res.json(await getLedgerAccountHistory(getActor(req), accountId(req), parseRequestQuery(z.object(paginationQueryFields), req.query)));
};

const handleUpdate: RequestHandler = async (req, res) => {
  res.json(await updateLedgerAccount(getActor(req), accountId(req), parseRequestBody(updateBodySchema, req.body)));
};

/** The chart of accounts. Accounts are deactivated rather than deleted, because ledger lines will name them. */
export const ledgerAccountRoutes: ApiRoute[] = [
  { method: 'GET', path: '/accounts/ledger-accounts', access: 'private', permission: 'ledgerAccount.read', handler: handleList },
  { method: 'POST', path: '/accounts/ledger-accounts', access: 'private', permission: 'ledgerAccount.create', bodySchema: createBodySchema, handler: handleCreate },
  { method: 'GET', path: '/accounts/ledger-accounts/:id', access: 'private', permission: 'ledgerAccount.read', handler: handleGet },
  { method: 'GET', path: '/accounts/ledger-accounts/:id/history', access: 'private', permission: 'ledgerAccount.read', handler: handleHistory },
  { method: 'PATCH', path: '/accounts/ledger-accounts/:id', access: 'private', permission: 'ledgerAccount.update', bodySchema: updateBodySchema, handler: handleUpdate },
];
