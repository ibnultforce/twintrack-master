import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { paginationQueryFields } from '../../../lib/query.js';
import { parseRequestBody, parseRequestQuery } from '../../../lib/validation.js';
import { getActor } from '../access/caller.js';
import { CLIENT_STATUSES } from '../models/client.js';
import { createClient, getClient, getClientHistory, listClients, updateClient } from './clients.service.js';

const MAX_NAME_LENGTH = 200;
const MAX_DETAIL_LENGTH = 300;
const MAX_NOTES_LENGTH = 5000;

const nameField = z.string().trim().min(1, 'is required').max(MAX_NAME_LENGTH);
const initialsField = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9]{1,8}$/, 'must be 1 to 8 letters or digits, such as ACME');
const emailField = z.email('must be an email address').max(MAX_DETAIL_LENGTH);
const detailField = z.string().trim().min(1, 'is required').max(MAX_DETAIL_LENGTH);
const notesField = z.string().trim().min(1, 'is required').max(MAX_NOTES_LENGTH);
const versionField = z.number().int().min(0);

const listQuerySchema = z.object({
  ...paginationQueryFields,
  search: z.string().trim().max(MAX_NAME_LENGTH).optional(),
  status: z.enum(CLIENT_STATUSES).optional(),
});

const historyQuerySchema = z.object(paginationQueryFields);

const createBodySchema = z.strictObject({
  name: nameField,
  initials: initialsField.optional(),
  contactEmail: emailField.optional(),
  contactPhone: detailField.optional(),
  address: detailField.optional(),
  notes: notesField.optional(),
});

// In an update, null clears an optional detail.
const updateBodySchema = z
  .strictObject({
    name: nameField.optional(),
    initials: initialsField.nullable().optional(),
    contactEmail: emailField.nullable().optional(),
    contactPhone: detailField.nullable().optional(),
    address: detailField.nullable().optional(),
    notes: notesField.nullable().optional(),
    version: versionField.optional(),
  })
  .refine(({ version: _version, ...changes }) => Object.keys(changes).length > 0, { message: 'send at least one field to change' });

const statusBodySchema = z.strictObject({ status: z.enum(CLIENT_STATUSES), version: versionField.optional() });

const clientIdFrom = (params: Record<string, unknown>) => String(params.id);

const handleList: RequestHandler = async (req, res) => {
  res.json(await listClients(getActor(req), parseRequestQuery(listQuerySchema, req.query)));
};

const handleGet: RequestHandler = async (req, res) => {
  res.json(await getClient(getActor(req), clientIdFrom(req.params)));
};

const handleCreate: RequestHandler = async (req, res) => {
  res.status(201).json(await createClient(getActor(req), parseRequestBody(createBodySchema, req.body)));
};

const handleUpdate: RequestHandler = async (req, res) => {
  res.json(await updateClient(getActor(req), clientIdFrom(req.params), parseRequestBody(updateBodySchema, req.body)));
};

const handleSetStatus: RequestHandler = async (req, res) => {
  res.json(await updateClient(getActor(req), clientIdFrom(req.params), parseRequestBody(statusBodySchema, req.body)));
};

const handleHistory: RequestHandler = async (req, res) => {
  res.json(await getClientHistory(getActor(req), clientIdFrom(req.params), parseRequestQuery(historyQuerySchema, req.query)));
};

/** Clients are shared reference data, so they aren't scoped: anyone with client.read sees them all. */
export const clientsRoutes: ApiRoute[] = [
  { method: 'GET', path: '/clients', access: 'private', permission: 'client.read', handler: handleList },
  { method: 'POST', path: '/clients', access: 'private', permission: 'client.create', handler: handleCreate },
  { method: 'GET', path: '/clients/:id', access: 'private', permission: 'client.read', handler: handleGet },
  { method: 'PATCH', path: '/clients/:id', access: 'private', permission: 'client.update', handler: handleUpdate },
  { method: 'PATCH', path: '/clients/:id/status', access: 'private', permission: 'client.update', handler: handleSetStatus },
  { method: 'GET', path: '/clients/:id/history', access: 'private', permission: 'client.read', handler: handleHistory },
];
