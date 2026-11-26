import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { getActor } from '../../master/access/caller.js';
import { paginationQueryFields } from '../../../lib/query.js';
import { parseRequestQuery } from '../../../lib/validation.js';
import { accountingDateField, recordIdField } from '../accountsFields.js';
import { getGeneralLedger, getOfficeExpenses, getTrialBalanceView } from './generalLedger.service.js';

const ledgerQuerySchema = z
  .object({ ...paginationQueryFields, accountId: recordIdField, from: accountingDateField, to: accountingDateField })
  .refine(({ from, to }) => from <= to, { message: 'from must be on or before to', path: ['to'] });

const trialBalanceQuerySchema = z.object({ to: accountingDateField.optional() });

const periodQuerySchema = z
  .object({ from: accountingDateField, to: accountingDateField })
  .refine(({ from, to }) => from <= to, { message: 'from must be on or before to', path: ['to'] });

const handleOfficeExpenses: RequestHandler = async (req, res) => {
  const { from, to } = parseRequestQuery(periodQuerySchema, req.query);
  res.json(await getOfficeExpenses(from, to));
};
const handleLedger: RequestHandler = async (req, res) => {
  res.json(await getGeneralLedger(getActor(req), parseRequestQuery(ledgerQuerySchema, req.query)));
};
const handleTrialBalance: RequestHandler = async (req, res) => {
  res.json(await getTrialBalanceView(parseRequestQuery(trialBalanceQuerySchema, req.query).to));
};

/** Reading the books: one account's lines with a running balance, the trial balance, and office expenses. All need chart read access. */
export const generalLedgerRoutes: ApiRoute[] = [
  { method: 'GET', path: '/accounts/general-ledger', access: 'private', permission: 'ledgerAccount.read', handler: handleLedger },
  { method: 'GET', path: '/accounts/trial-balance', access: 'private', permission: 'ledgerAccount.read', handler: handleTrialBalance },
  { method: 'GET', path: '/accounts/office-expenses', access: 'private', permission: 'ledgerAccount.read', handler: handleOfficeExpenses },
];
