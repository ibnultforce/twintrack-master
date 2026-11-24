import type { Request, RequestHandler } from 'express';
import { z } from 'zod';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { parseRequestBody, parseRequestQuery } from '../../../lib/validation.js';
import { getActor } from '../../master/access/caller.js';
import { accountingDateField, recordIdField, versionField } from '../accountsFields.js';
import {
  completeReconciliation,
  getBankStatement,
  importBankStatement,
  listBankStatements,
  matchStatementLine,
  rematchStatement,
  unmatchStatementLine,
} from './bankReconciliation.service.js';

/** A bank CSV of a few thousand lines is well under this. */
const MAX_CSV_CHARACTERS = 2_000_000;
const balanceField = z.number().int('must be whole paisa').min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);

const importBodySchema = z
  .strictObject({
    accountId: recordIdField,
    from: accountingDateField,
    to: accountingDateField,
    openingBalance: balanceField,
    closingBalance: balanceField,
    csv: z.string().min(1, 'is required').max(MAX_CSV_CHARACTERS),
    fileName: z.string().trim().max(200).optional(),
  })
  .refine(({ from, to }) => from <= to, { message: 'from must be on or before to', path: ['to'] });

const matchBodySchema = z.strictObject({ entryId: recordIdField, version: versionField.optional() });
const versionBodySchema = z.strictObject({ version: versionField.optional() });

const statementId = (req: Request) => String(req.params.id);
const lineId = (req: Request) => String(req.params.lineId);
const bodyOf = (req: Request) => req.body ?? {};

const handleList: RequestHandler = async (req, res) => {
  res.json(await listBankStatements(parseRequestQuery(z.object({ accountId: recordIdField.optional() }), req.query).accountId));
};
const handleGet: RequestHandler = async (req, res) => {
  res.json(await getBankStatement(statementId(req)));
};
const handleImport: RequestHandler = async (req, res) => {
  res.status(201).json(await importBankStatement(getActor(req), parseRequestBody(importBodySchema, req.body)));
};
const handleMatch: RequestHandler = async (req, res) => {
  res.json(await matchStatementLine(getActor(req), statementId(req), lineId(req), parseRequestBody(matchBodySchema, req.body)));
};
const handleUnmatch: RequestHandler = async (req, res) => {
  res.json(await unmatchStatementLine(getActor(req), statementId(req), lineId(req), parseRequestBody(versionBodySchema, bodyOf(req)).version));
};
const handleRematch: RequestHandler = async (req, res) => {
  res.json(await rematchStatement(getActor(req), statementId(req), parseRequestBody(versionBodySchema, bodyOf(req)).version));
};
const handleComplete: RequestHandler = async (req, res) => {
  res.json(await completeReconciliation(getActor(req), statementId(req), parseRequestBody(versionBodySchema, bodyOf(req)).version));
};

const BASE = '/accounts/bank-reconciliations';

/** Bank statements loaded from CSV and matched against the books. The books themselves are never changed here. */
export const bankReconciliationRoutes: ApiRoute[] = [
  { method: 'GET', path: BASE, access: 'private', permission: 'bankReconciliation.read', handler: handleList },
  { method: 'POST', path: BASE, access: 'private', permission: 'bankReconciliation.create', bodySchema: importBodySchema, handler: handleImport },
  { method: 'GET', path: `${BASE}/:id`, access: 'private', permission: 'bankReconciliation.read', handler: handleGet },
  { method: 'POST', path: `${BASE}/:id/lines/:lineId/match`, access: 'private', permission: 'bankReconciliation.update', bodySchema: matchBodySchema, handler: handleMatch },
  { method: 'POST', path: `${BASE}/:id/lines/:lineId/unmatch`, access: 'private', permission: 'bankReconciliation.update', bodySchema: versionBodySchema, handler: handleUnmatch },
  { method: 'POST', path: `${BASE}/:id/rematch`, access: 'private', permission: 'bankReconciliation.update', bodySchema: versionBodySchema, handler: handleRematch },
  { method: 'POST', path: `${BASE}/:id/complete`, access: 'private', permission: 'bankReconciliation.update', bodySchema: versionBodySchema, handler: handleComplete },
];
