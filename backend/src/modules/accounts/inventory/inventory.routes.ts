import type { Request, RequestHandler } from 'express';
import { z } from 'zod';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { paginationQueryFields } from '../../../lib/query.js';
import { parseRequestBody, parseRequestQuery } from '../../../lib/validation.js';
import { getActor } from '../../master/access/caller.js';
import { accountingDateField, versionField } from '../accountsFields.js';
import { MOVEMENT_KINDS } from '../models/inventoryItem.js';
import { addMovement, createInventoryItem, getInventoryItem, listInventoryItems, updateInventoryItem } from './inventory.service.js';

const MAX_QUANTITY = 1_000_000;

const quantityField = z
  .number()
  .min(-MAX_QUANTITY)
  .max(MAX_QUANTITY)
  // Thousandths, allowing for how decimals are stored: 0.001 × 1000 isn't exactly 1.
  .refine((quantity) => Math.abs(quantity * 1000 - Math.round(quantity * 1000)) < 1e-6, 'may have up to 3 decimals');
const textField = (max: number) => z.string().trim().min(1, 'is required').max(max);
const reorderField = z.number().min(0).max(MAX_QUANTITY);

const createBodySchema = z.strictObject({
  name: textField(200),
  assetTag: z.string().trim().max(60).optional(),
  category: textField(60),
  unit: textField(20),
  reorderLevel: reorderField.optional(),
});

const updateBodySchema = z
  .strictObject({
    name: textField(200).optional(),
    // null clears it.
    assetTag: z.string().trim().min(1).max(60).nullable().optional(),
    category: textField(60).optional(),
    unit: textField(20).optional(),
    reorderLevel: reorderField.nullable().optional(),
    isActive: z.boolean().optional(),
    version: versionField.optional(),
  })
  .refine(({ version: _version, ...changes }) => Object.keys(changes).length > 0, { message: 'send at least one field to change' });

const movementBodySchema = z.strictObject({
  date: accountingDateField,
  kind: z.enum(MOVEMENT_KINDS),
  quantity: quantityField,
  note: z.string().trim().max(500).optional(),
  reference: z.string().trim().max(100).optional(),
});

const listQuerySchema = z.object({
  ...paginationQueryFields,
  isActive: z.enum(['true', 'false']).optional().transform((value) => (value === undefined ? undefined : value === 'true')),
  search: z.string().trim().max(100).optional().transform((text) => text || undefined),
});

const itemId = (req: Request) => String(req.params.id);

const handleList: RequestHandler = async (req, res) => {
  res.json(await listInventoryItems(getActor(req), parseRequestQuery(listQuerySchema, req.query)));
};
const handleGet: RequestHandler = async (req, res) => {
  res.json(await getInventoryItem(getActor(req), itemId(req)));
};
const handleCreate: RequestHandler = async (req, res) => {
  res.status(201).json(await createInventoryItem(getActor(req), parseRequestBody(createBodySchema, req.body)));
};
const handleUpdate: RequestHandler = async (req, res) => {
  res.json(await updateInventoryItem(getActor(req), itemId(req), parseRequestBody(updateBodySchema, req.body)));
};
const handleMovement: RequestHandler = async (req, res) => {
  res.status(201).json(await addMovement(getActor(req), itemId(req), parseRequestBody(movementBodySchema, req.body)));
};

const BASE = '/accounts/inventory-items';

/** Office stock: items with an asset tag, and movements in, out and counted. Stock on hand comes from the movements. */
export const inventoryRoutes: ApiRoute[] = [
  { method: 'GET', path: BASE, access: 'private', permission: 'inventoryItem.read', handler: handleList },
  { method: 'POST', path: BASE, access: 'private', permission: 'inventoryItem.create', bodySchema: createBodySchema, handler: handleCreate },
  { method: 'GET', path: `${BASE}/:id`, access: 'private', permission: 'inventoryItem.read', handler: handleGet },
  { method: 'PATCH', path: `${BASE}/:id`, access: 'private', permission: 'inventoryItem.update', bodySchema: updateBodySchema, handler: handleUpdate },
  { method: 'POST', path: `${BASE}/:id/movements`, access: 'private', permission: 'inventoryItem.update', bodySchema: movementBodySchema, handler: handleMovement },
];
