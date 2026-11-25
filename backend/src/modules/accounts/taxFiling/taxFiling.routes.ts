import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { parseRequestBody, parseRequestQuery } from '../../../lib/validation.js';
import { getActor } from '../../master/access/caller.js';
import { accountingDateField, financialYearQuerySchema, monthField, recordIdField } from '../accountsFields.js';
import { getTaxFilings, payVendorTds } from './taxFiling.service.js';

const payBodySchema = z.strictObject({
  paymentDate: accountingDateField,
  moneyAccountId: recordIdField,
  challanNumber: z.string().trim().min(1, 'is required').max(100),
});

const handleList: RequestHandler = async (req, res) => {
  res.json(await getTaxFilings(parseRequestQuery(financialYearQuerySchema, req.query).year));
};
const handlePay: RequestHandler = async (req, res) => {
  const { month } = parseRequestQuery(z.object({ month: monthField }), { month: req.params.month });
  res.status(201).json(await payVendorTds(getActor(req), month, parseRequestBody(payBodySchema, req.body)));
};

/** Tax and VAT from recorded bills, month by month. Paying TDS makes a payment voucher someone else approves. */
export const taxFilingRoutes: ApiRoute[] = [
  { method: 'GET', path: '/accounts/tax-filings', access: 'private', permission: 'taxFiling.read', handler: handleList },
  { method: 'POST', path: '/accounts/tax-filings/:month/pay', access: 'private', permission: 'journalVoucher.create', bodySchema: payBodySchema, handler: handlePay },
];
