import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { parseRequestBody, parseRequestQuery } from '../../../lib/validation.js';
import { getActor } from '../../master/access/caller.js';
import { accountingDateField, financialYearQuerySchema, monthField, recordIdField } from '../accountsFields.js';
import { depositProvidentFund, getProvidentFund } from './providentFund.service.js';

const depositBodySchema = z.strictObject({ paymentDate: accountingDateField, moneyAccountId: recordIdField, reference: z.string().trim().max(100).optional() });

const handleGet: RequestHandler = async (req, res) => {
  res.json(await getProvidentFund(parseRequestQuery(financialYearQuerySchema, req.query).year));
};
const handleDeposit: RequestHandler = async (req, res) => {
  const { month } = parseRequestQuery(z.object({ month: monthField }), { month: req.params.month });
  res.status(201).json(await depositProvidentFund(getActor(req), month, parseRequestBody(depositBodySchema, req.body)));
};

/** Provident fund and gratuity, read from recorded payroll runs. A deposit is a payment voucher someone else approves. */
export const providentFundRoutes: ApiRoute[] = [
  { method: 'GET', path: '/accounts/provident-fund', access: 'private', permission: 'providentFund.read', handler: handleGet },
  { method: 'POST', path: '/accounts/provident-fund/:month/deposit', access: 'private', permission: 'journalVoucher.create', bodySchema: depositBodySchema, handler: handleDeposit },
];
