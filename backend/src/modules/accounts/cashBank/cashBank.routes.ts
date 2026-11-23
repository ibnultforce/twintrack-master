import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { parseRequestQuery } from '../../../lib/validation.js';
import { getActor } from '../../master/access/caller.js';
import { accountingDateField } from '../accountsFields.js';
import { todayAsEntryDate } from '../ledger/ledger.service.js';
import { getCashAndBank } from './cashBank.service.js';

/** The first day of the current month, YYYY-MM-DD. */
const startOfThisMonth = () => `${todayAsEntryDate().slice(0, 7)}-01`;

const periodQuerySchema = z
  .object({ from: accountingDateField.optional(), to: accountingDateField.optional() })
  .transform(({ from, to }) => ({ from: from ?? startOfThisMonth(), to: to ?? todayAsEntryDate() }))
  .refine(({ from, to }) => from <= to, { message: 'from must be on or before to', path: ['to'] });

const handleGet: RequestHandler = async (req, res) => {
  res.json(await getCashAndBank(getActor(req), parseRequestQuery(periodQuerySchema, req.query)));
};

/** Balances of the cash and bank accounts, worked out from the ledger. Reading the chart of accounts is enough. */
export const cashBankRoutes: ApiRoute[] = [
  { method: 'GET', path: '/accounts/cash-bank', access: 'private', permission: 'ledgerAccount.read', handler: handleGet },
];
