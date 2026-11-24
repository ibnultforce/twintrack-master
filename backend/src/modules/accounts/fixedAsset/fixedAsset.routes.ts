import type { Request, RequestHandler } from 'express';
import { z } from 'zod';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { paginationQueryFields } from '../../../lib/query.js';
import { parseRequestBody, parseRequestQuery } from '../../../lib/validation.js';
import { getActor } from '../../master/access/caller.js';
import { accountingDateField, minorUnitsField, recordIdField, versionField } from '../accountsFields.js';
import { ASSET_CATEGORIES } from '../models/fixedAsset.js';
import {
  createFixedAsset,
  getFixedAsset,
  getFixedAssetHistory,
  listFixedAssets,
  previewDepreciation,
  runDepreciation,
  updateFixedAsset,
} from './fixedAsset.service.js';

/** Fifty years: longer than anything an office depreciates. */
const MAX_LIFE_MONTHS = 600;

const monthField = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'must be a month as YYYY-MM');
const nameField = z.string().trim().min(1, 'is required').max(200);
const tagField = z.string().trim().max(60);
const lifeField = z.number().int('must be whole months').min(1).max(MAX_LIFE_MONTHS);

const createBodySchema = z.strictObject({
  name: nameField,
  assetTag: tagField.optional(),
  category: z.enum(ASSET_CATEGORIES),
  purchaseDate: accountingDateField,
  cost: minorUnitsField.min(1, 'must be above zero'),
  salvageValue: minorUnitsField,
  usefulLifeMonths: lifeField,
  billId: recordIdField.optional(),
});

const updateBodySchema = z
  .strictObject({
    name: nameField.optional(),
    assetTag: tagField.optional(),
    category: z.enum(ASSET_CATEGORIES).optional(),
    purchaseDate: accountingDateField.optional(),
    cost: minorUnitsField.min(1, 'must be above zero').optional(),
    salvageValue: minorUnitsField.optional(),
    usefulLifeMonths: lifeField.optional(),
    isActive: z.boolean().optional(),
    version: versionField.optional(),
  })
  .refine(({ version: _version, ...changes }) => Object.keys(changes).length > 0, { message: 'send at least one field to change' });

const listQuerySchema = z.object({
  ...paginationQueryFields,
  category: z.enum(ASSET_CATEGORIES).optional(),
  isActive: z.enum(['true', 'false']).optional().transform((value) => (value === undefined ? undefined : value === 'true')),
  search: z.string().trim().max(100).optional().transform((text) => text || undefined),
});

const runBodySchema = z.strictObject({ month: monthField, voucherDate: accountingDateField.optional() });

const assetId = (req: Request) => String(req.params.id);

const handleList: RequestHandler = async (req, res) => {
  res.json(await listFixedAssets(getActor(req), parseRequestQuery(listQuerySchema, req.query)));
};
const handlePreview: RequestHandler = async (req, res) => {
  res.json(await previewDepreciation(parseRequestQuery(z.object({ month: monthField }), req.query).month));
};
const handleRun: RequestHandler = async (req, res) => {
  res.status(201).json(await runDepreciation(getActor(req), parseRequestBody(runBodySchema, req.body)));
};
const handleGet: RequestHandler = async (req, res) => {
  res.json(await getFixedAsset(getActor(req), assetId(req)));
};
const handleCreate: RequestHandler = async (req, res) => {
  res.status(201).json(await createFixedAsset(getActor(req), parseRequestBody(createBodySchema, req.body)));
};
const handleUpdate: RequestHandler = async (req, res) => {
  res.json(await updateFixedAsset(getActor(req), assetId(req), parseRequestBody(updateBodySchema, req.body)));
};
const handleHistory: RequestHandler = async (req, res) => {
  res.json(await getFixedAssetHistory(getActor(req), assetId(req), parseRequestQuery(z.object(paginationQueryFields), req.query)));
};

const BASE = '/accounts/fixed-assets';

/**
 * The fixed asset register and its monthly depreciation. A depreciation run makes a journal voucher, so it also needs
 * journalVoucher.create, checked in the service. The depreciation paths come before /:id so they aren't read as an id.
 */
export const fixedAssetRoutes: ApiRoute[] = [
  { method: 'GET', path: BASE, access: 'private', permission: 'fixedAsset.read', handler: handleList },
  { method: 'POST', path: BASE, access: 'private', permission: 'fixedAsset.create', bodySchema: createBodySchema, handler: handleCreate },
  { method: 'GET', path: `${BASE}/depreciation`, access: 'private', permission: 'fixedAsset.read', handler: handlePreview },
  { method: 'POST', path: `${BASE}/depreciation`, access: 'private', permission: 'fixedAsset.update', bodySchema: runBodySchema, handler: handleRun },
  { method: 'GET', path: `${BASE}/:id`, access: 'private', permission: 'fixedAsset.read', handler: handleGet },
  { method: 'PATCH', path: `${BASE}/:id`, access: 'private', permission: 'fixedAsset.update', bodySchema: updateBodySchema, handler: handleUpdate },
  { method: 'GET', path: `${BASE}/:id/history`, access: 'private', permission: 'fixedAsset.read', handler: handleHistory },
];
