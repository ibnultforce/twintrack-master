import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { paginationQueryFields } from '../../../lib/query.js';
import { parseRequestBody, parseRequestQuery } from '../../../lib/validation.js';
import { getActor } from '../../master/access/caller.js';
import { activeStatusField, changesSomething, changesSomethingMessage, idField, nameField, versionField } from '../accountsFields.js';
import { createCategory, getCategory, getCategoryHistory, listCategories, updateCategory } from './category.service.js';

const MAX_CODE_LENGTH = 30;
const codeField = z.string().trim().regex(new RegExp(`^[A-Za-z0-9_-]{1,${MAX_CODE_LENGTH}}$`), `must be 1 to ${MAX_CODE_LENGTH} letters, digits, - or _`);

const listQuerySchema = z.object({ ...paginationQueryFields, status: activeStatusField.optional(), search: z.string().trim().max(100).optional() });
const pageQuerySchema = z.object(paginationQueryFields);
const createBodySchema = z.strictObject({ name: nameField, code: codeField, parentId: idField.optional() });
const updateBodySchema = z
  .strictObject({ name: nameField.optional(), code: codeField.optional(), parentId: idField.optional(), status: activeStatusField.optional(), version: versionField.optional() })
  .refine(changesSomething, changesSomethingMessage);

const id = (params: Record<string, unknown>) => String(params.id);

const handleList: RequestHandler = async (req, res) => {
  res.json(await listCategories(getActor(req), parseRequestQuery(listQuerySchema, req.query)));
};
const handleGet: RequestHandler = async (req, res) => {
  res.json(await getCategory(getActor(req), id(req.params)));
};
const handleCreate: RequestHandler = async (req, res) => {
  res.status(201).json(await createCategory(getActor(req), parseRequestBody(createBodySchema, req.body)));
};
const handleUpdate: RequestHandler = async (req, res) => {
  res.json(await updateCategory(getActor(req), id(req.params), parseRequestBody(updateBodySchema, req.body)));
};
const handleHistory: RequestHandler = async (req, res) => {
  res.json(await getCategoryHistory(getActor(req), id(req.params), parseRequestQuery(pageQuerySchema, req.query)));
};

export const categoryRoutes: ApiRoute[] = [
  { method: 'GET', path: '/accounts/categories', access: 'private', permission: 'category.read', handler: handleList },
  { method: 'POST', path: '/accounts/categories', access: 'private', permission: 'category.create', handler: handleCreate },
  { method: 'GET', path: '/accounts/categories/:id', access: 'private', permission: 'category.read', handler: handleGet },
  { method: 'PATCH', path: '/accounts/categories/:id', access: 'private', permission: 'category.update', handler: handleUpdate },
  { method: 'GET', path: '/accounts/categories/:id/history', access: 'private', permission: 'category.read', handler: handleHistory },
];
