import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { parseRequestBody } from '../../../lib/validation.js';
import { getActor } from '../../master/access/caller.js';
import { accountingDateField, recordIdField, versionField } from '../accountsFields.js';
import { HOME_CURRENCY } from '../models/accountsSettings.js';
import { getSettings, listApproverCandidates, updateSettings } from './settings.service.js';

const MAX_RATES = 100;
/** 1,000,000.00 taka per unit: far above any real rate, and a guard against a misplaced decimal point. */
const MAX_PAISA_PER_UNIT = 100_000_000;
/** 100%. */
const MAX_BASIS_POINTS = 10_000;

const currencyCodeField = z
  .string()
  .trim()
  .regex(/^[A-Z]{3,10}$/, 'must be 3 to 10 capital letters, such as USD or USDT')
  .refine((code) => code !== HOME_CURRENCY, 'is the home currency, which needs no rate');

const currencySchema = z.strictObject({
  code: currencyCodeField,
  name: z.string().trim().min(1, 'is required').max(100),
});

const exchangeRateSchema = z.strictObject({
  currency: currencyCodeField,
  effectiveFrom: accountingDateField,
  paisaPerUnit: z.number().int('must be whole paisa').min(1).max(MAX_PAISA_PER_UNIT),
});

const taxRateSchema = z.strictObject({
  code: z.string().trim().regex(/^[A-Z0-9_]{1,20}$/, 'must be 1 to 20 capital letters, digits or underscores, such as VAT15'),
  name: z.string().trim().min(1, 'is required').max(100),
  basisPoints: z.number().int('must be whole basis points (1500 is 15%)').min(0).max(MAX_BASIS_POINTS),
});

const updateBodySchema = z
  .strictObject({
    // null clears the stand-in, and with it the end date.
    standInApproverId: recordIdField.nullable().optional(),
    standInUntil: accountingDateField.nullable().optional(),
    currencies: z.array(currencySchema).max(MAX_RATES).optional(),
    // The home currency or one of the currencies; checked against the list in the service.
    defaultCurrency: z.string().trim().regex(/^[A-Z]{3,10}$/, 'must be a currency code, such as BDT or USD').optional(),
    exchangeRates: z.array(exchangeRateSchema).max(MAX_RATES).optional(),
    taxRates: z.array(taxRateSchema).max(MAX_RATES).optional(),
    version: versionField.optional(),
  })
  .refine(({ version: _version, ...changes }) => Object.keys(changes).length > 0, { message: 'send at least one field to change' });

const handleGet: RequestHandler = async (req, res) => {
  res.json(await getSettings(getActor(req)));
};

const handleUpdate: RequestHandler = async (req, res) => {
  res.json(await updateSettings(getActor(req), parseRequestBody(updateBodySchema, req.body)));
};

const handleApproverCandidates: RequestHandler = async (_req, res) => {
  res.json(await listApproverCandidates());
};

/** One settings record for the whole module: the stand-in approver, currencies, exchange rates and tax rates, each a field a profile can hide or make read-only. */
export const settingsRoutes: ApiRoute[] = [
  { method: 'GET', path: '/accounts/settings', access: 'private', permission: 'setting.read', handler: handleGet },
  { method: 'PATCH', path: '/accounts/settings', access: 'private', permission: 'setting.update', bodySchema: updateBodySchema, handler: handleUpdate },
  { method: 'GET', path: '/accounts/settings/approver-candidates', access: 'private', permission: 'setting.update', handler: handleApproverCandidates },
];
