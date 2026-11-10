import type { Request, RequestHandler } from 'express';
import { z } from 'zod';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { paginationQueryFields } from '../../../lib/query.js';
import { parseRequestBody, parseRequestQuery } from '../../../lib/validation.js';
import { getActor, getCaller } from '../access/caller.js';
import { GRANTEE_TYPES, SHARE_ACCESS } from '../models/recordShare.js';
import { addCustomObject, parseObjectDefinition, removeCustomObject, updateCustomObject } from './customObjects.service.js';
import {
  createCustomRecord,
  deleteCustomRecord,
  getCustomRecord,
  getCustomRecordHistory,
  listCustomRecords,
  listCustomRecordShares,
  listReadableObjects,
  openObject,
  restoreCustomRecord,
  shareCustomRecord,
  unshareCustomRecord,
  updateCustomRecord,
} from './customRecords.service.js';

const MAX_ID_LENGTH = 100;

const listQuerySchema = z.object({
  ...paginationQueryFields,
  // Query strings carry text, so only the word true asks for the recycle bin.
  deleted: z.enum(['true', 'false']).optional().transform((value) => value === 'true'),
});
const historyQuerySchema = z.object(paginationQueryFields);
// The values themselves are checked against the object's field definitions by the service.
const createBodySchema = z.strictObject({ values: z.record(z.string(), z.unknown()) });
const updateBodySchema = z.strictObject({ values: z.record(z.string(), z.unknown()), version: z.number().int().min(0).optional() });
const shareBodySchema = z.strictObject({
  granteeType: z.enum(GRANTEE_TYPES),
  granteeId: z.string().min(1, 'is required').max(MAX_ID_LENGTH),
  access: z.enum(SHARE_ACCESS),
  expiresAt: z.iso.datetime('must be a date and time, such as 2027-01-01T00:00:00Z').transform((value) => new Date(value)).optional(),
});
const newObjectBodySchema = z.looseObject({ key: z.string().min(1, 'is required') });

/** The module, object and permission come from the path, so each handler opens the object for the action it needs. */
const open = (req: Request, action: 'read' | 'create' | 'update' | 'delete') =>
  openObject(getCaller(req), req.ip, String(req.params.module), String(req.params.object), action);
const recordIdFrom = (req: Request) => String(req.params.id);

const handlers: Record<string, RequestHandler> = {
  listObjects: async (req, res) => {
    res.json({ objects: await listReadableObjects(getCaller(req)) });
  },
  addObject: async (req, res) => {
    const { key, ...definition } = parseRequestBody(newObjectBodySchema, req.body);
    res.status(201).json(await addCustomObject(getActor(req), String(req.params.key), key, parseObjectDefinition(definition)));
  },
  updateObject: async (req, res) => {
    res.json(await updateCustomObject(getActor(req), String(req.params.key), String(req.params.object), parseObjectDefinition(req.body)));
  },
  removeObject: async (req, res) => {
    res.json(await removeCustomObject(getActor(req), String(req.params.key), String(req.params.object)));
  },
  list: async (req, res) => {
    res.json(await listCustomRecords(await open(req, 'read'), parseRequestQuery(listQuerySchema, req.query)));
  },
  read: async (req, res) => {
    res.json(await getCustomRecord(await open(req, 'read'), recordIdFrom(req)));
  },
  create: async (req, res) => {
    const context = await open(req, 'create');
    res.status(201).json(await createCustomRecord(context, parseRequestBody(createBodySchema, req.body).values));
  },
  update: async (req, res) => {
    const context = await open(req, 'update');
    const { values, version } = parseRequestBody(updateBodySchema, req.body);
    res.json(await updateCustomRecord(context, recordIdFrom(req), values, version));
  },
  remove: async (req, res) => {
    res.json(await deleteCustomRecord(await open(req, 'delete'), recordIdFrom(req)));
  },
  restore: async (req, res) => {
    res.json(await restoreCustomRecord(await open(req, 'delete'), recordIdFrom(req)));
  },
  history: async (req, res) => {
    res.json(await getCustomRecordHistory(await open(req, 'read'), recordIdFrom(req), parseRequestQuery(historyQuerySchema, req.query)));
  },
  listShares: async (req, res) => {
    res.json(await listCustomRecordShares(await open(req, 'read'), recordIdFrom(req)));
  },
  share: async (req, res) => {
    const context = await open(req, 'read');
    res.status(201).json(await shareCustomRecord(context, recordIdFrom(req), parseRequestBody(shareBodySchema, req.body)));
  },
  unshare: async (req, res) => {
    res.json(await unshareCustomRecord(await open(req, 'read'), recordIdFrom(req), String(req.params.shareId)));
  },
};

const RECORDS = '/records/:module/:object';

export const customObjectsRoutes: ApiRoute[] = [
  { method: 'POST', path: '/modules/:key/objects', access: 'private', permission: 'module.create', handler: handlers.addObject! },
  { method: 'PUT', path: '/modules/:key/objects/:object', access: 'private', permission: 'module.update', handler: handlers.updateObject! },
  { method: 'DELETE', path: '/modules/:key/objects/:object', access: 'private', permission: 'module.delete', handler: handlers.removeObject! },
  // Signed, because the permission is held in the module named in the path. The service checks it, as the middleware would.
  { method: 'GET', path: '/records', access: 'signed', handler: handlers.listObjects! },
  { method: 'GET', path: RECORDS, access: 'signed', handler: handlers.list! },
  { method: 'POST', path: RECORDS, access: 'signed', handler: handlers.create! },
  { method: 'GET', path: `${RECORDS}/:id`, access: 'signed', handler: handlers.read! },
  { method: 'PATCH', path: `${RECORDS}/:id`, access: 'signed', handler: handlers.update! },
  { method: 'DELETE', path: `${RECORDS}/:id`, access: 'signed', handler: handlers.remove! },
  { method: 'POST', path: `${RECORDS}/:id/restore`, access: 'signed', handler: handlers.restore! },
  { method: 'GET', path: `${RECORDS}/:id/history`, access: 'signed', handler: handlers.history! },
  { method: 'GET', path: `${RECORDS}/:id/shares`, access: 'signed', handler: handlers.listShares! },
  { method: 'POST', path: `${RECORDS}/:id/shares`, access: 'signed', handler: handlers.share! },
  { method: 'DELETE', path: `${RECORDS}/:id/shares/:shareId`, access: 'signed', handler: handlers.unshare! },
];
