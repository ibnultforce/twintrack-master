import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { paginationQueryFields } from '../../../lib/query.js';
import { parseRequestQuery } from '../../../lib/validation.js';
import { accountingDateField, recordIdField } from '../accountsFields.js';
import { getGeneralLedger, getTrialBalanceView } from './generalLedger.service.js';

const ledgerQuerySchema = z
  .object({ ...paginationQueryFields, accountId: recordIdField, from: accountingDateField, to: accountingDateField })
  .refine(({ from, to }) => from <= to, { message: 'from must be on or before to', path: ['to'] });

const trialBalanceQuerySchema = z.object({ to: accountingDateField.optional() });

const handleLedger: RequestHandler = async (req, res) => {
  res.json(await getGeneralLedger(parseRequestQuery(ledgerQuerySchema, req.query)));
};
const handleTrialBalance: RequestHandler = async (req, res) => {
  res.json(await getTrialBalanceView(parseRequestQuery(trialBalanceQuerySchema, req.query).to));
};

/** Reading the books: one account's lines with a running balance, and the trial balance. Both need chart read access. */
export const generalLedgerRoutes: ApiRoute[] = [
  { method: 'GET', path: '/accounts/general-ledger', access: 'private', permission: 'ledgerAccount.read', handler: handleLedger },
  { method: 'GET', path: '/accounts/trial-balance', access: 'private', permission: 'ledgerAccount.read', handler: handleTrialBalance },
];
