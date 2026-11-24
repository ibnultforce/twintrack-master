import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { paginationQueryFields } from '../../../lib/query.js';
import { parseRequestBody, parseRequestQuery } from '../../../lib/validation.js';
import { getActor } from '../../master/access/caller.js';
import { versionField } from '../accountsFields.js';
import { VENDOR_CATEGORIES } from '../models/vendor.js';
import { createVendor, getVendor, getVendorHistory, listVendors, updateVendor } from './vendor.service.js';

/** 100%. */
const MAX_BASIS_POINTS = 10_000;

const nameField = z.string().trim().min(1, 'is required').max(200);
const tdsField = z.number().int('must be whole basis points (500 is 5%)').min(0).max(MAX_BASIS_POINTS);
const emailField = z.string().trim().toLowerCase().email('must be an email address').max(200);
const phoneField = z.string().trim().min(1).max(40);

const createBodySchema = z.strictObject({
  name: nameField,
  category: z.enum(VENDOR_CATEGORIES),
  tdsBasisPoints: tdsField,
  contactEmail: emailField.optional(),
  contactPhone: phoneField.optional(),
});

const updateBodySchema = z
  .strictObject({
    name: nameField.optional(),
    category: z.enum(VENDOR_CATEGORIES).optional(),
    tdsBasisPoints: tdsField.optional(),
    // null clears it.
    contactEmail: emailField.nullable().optional(),
    contactPhone: phoneField.nullable().optional(),
    isActive: z.boolean().optional(),
    version: versionField.optional(),
  })
  .refine(({ version: _version, ...changes }) => Object.keys(changes).length > 0, { message: 'send at least one field to change' });

const listQuerySchema = z.object({
  ...paginationQueryFields,
  category: z.enum(VENDOR_CATEGORIES).optional(),
  isActive: z.enum(['true', 'false']).optional().transform((value) => (value === undefined ? undefined : value === 'true')),
  search: z.string().trim().max(100).optional().transform((text) => text || undefined),
});

const vendorId = (req: Parameters<RequestHandler>[0]) => String(req.params.id);

const handleList: RequestHandler = async (req, res) => {
  res.json(await listVendors(getActor(req), parseRequestQuery(listQuerySchema, req.query)));
};
const handleGet: RequestHandler = async (req, res) => {
  res.json(await getVendor(getActor(req), vendorId(req)));
};
const handleCreate: RequestHandler = async (req, res) => {
  res.status(201).json(await createVendor(getActor(req), parseRequestBody(createBodySchema, req.body)));
};
const handleUpdate: RequestHandler = async (req, res) => {
  res.json(await updateVendor(getActor(req), vendorId(req), parseRequestBody(updateBodySchema, req.body)));
};
const handleHistory: RequestHandler = async (req, res) => {
  res.json(await getVendorHistory(getActor(req), vendorId(req), parseRequestQuery(z.object(paginationQueryFields), req.query)));
};

const BASE = '/accounts/vendors';

/** People and companies the company buys from, each with the TDS rate withheld from their bills. */
export const vendorRoutes: ApiRoute[] = [
  { method: 'GET', path: BASE, access: 'private', permission: 'vendor.read', handler: handleList },
  { method: 'POST', path: BASE, access: 'private', permission: 'vendor.create', bodySchema: createBodySchema, handler: handleCreate },
  { method: 'GET', path: `${BASE}/:id`, access: 'private', permission: 'vendor.read', handler: handleGet },
  { method: 'PATCH', path: `${BASE}/:id`, access: 'private', permission: 'vendor.update', bodySchema: updateBodySchema, handler: handleUpdate },
  { method: 'GET', path: `${BASE}/:id/history`, access: 'private', permission: 'vendor.read', handler: handleHistory },
];
