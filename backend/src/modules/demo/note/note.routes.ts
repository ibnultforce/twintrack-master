import type { Request, RequestHandler } from 'express';
import { z } from 'zod';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { paginationQueryFields } from '../../../lib/query.js';
import { parseRequestBody, parseRequestQuery } from '../../../lib/validation.js';
import { getActor } from '../../master/access/caller.js';
import { getPermissionScope as scopeOf } from '../../master/access/scope.js';
import { NOTE_STATUSES } from '../models/note.js';
import { createNote, deleteNote, getNote, listNotes, updateNote } from './note.service.js';

const MAX_TITLE_LENGTH = 200;
const MAX_BODY_LENGTH = 5000;

const titleField = z.string().trim().min(1, 'is required').max(MAX_TITLE_LENGTH);
const bodyField = z.string().max(MAX_BODY_LENGTH);

const listQuerySchema = z.object({ ...paginationQueryFields, status: z.enum(NOTE_STATUSES).optional() });

const createBodySchema = z.strictObject({ title: titleField, body: bodyField.optional() });

const updateBodySchema = z
  .strictObject({ title: titleField.optional(), body: bodyField.optional(), status: z.enum(NOTE_STATUSES).optional() })
  .refine((changes) => Object.keys(changes).length > 0, { message: 'send at least one field to change' });

const noteId = (req: Request) => String(req.params.id);

const handleList: RequestHandler = async (req, res) => {
  res.json(await listNotes(getActor(req), scopeOf(req), parseRequestQuery(listQuerySchema, req.query)));
};

const handleGet: RequestHandler = async (req, res) => {
  res.json(await getNote(getActor(req), scopeOf(req), noteId(req)));
};

const handleCreate: RequestHandler = async (req, res) => {
  res.status(201).json(await createNote(getActor(req), parseRequestBody(createBodySchema, req.body)));
};

const handleUpdate: RequestHandler = async (req, res) => {
  res.json(await updateNote(getActor(req), scopeOf(req), noteId(req), parseRequestBody(updateBodySchema, req.body)));
};

const handleDelete: RequestHandler = async (req, res) => {
  res.json(await deleteNote(getActor(req), scopeOf(req), noteId(req)));
};

export const noteRoutes: ApiRoute[] = [
  { method: 'GET', path: '/demo/notes', access: 'private', permission: 'note.read', handler: handleList },
  { method: 'GET', path: '/demo/notes/:id', access: 'private', permission: 'note.read', handler: handleGet },
  { method: 'POST', path: '/demo/notes', access: 'private', permission: 'note.create', bodySchema: createBodySchema, handler: handleCreate },
  { method: 'PATCH', path: '/demo/notes/:id', access: 'private', permission: 'note.update', bodySchema: updateBodySchema, handler: handleUpdate },
  { method: 'DELETE', path: '/demo/notes/:id', access: 'private', permission: 'note.delete', handler: handleDelete },
];
