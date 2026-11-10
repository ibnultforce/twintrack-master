import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { paginationQueryFields } from '../../../lib/query.js';
import { parseRequestBody, parseRequestQuery } from '../../../lib/validation.js';
import { getActor } from '../../master/access/caller.js';
import { getPermissionScope as scopeOf } from '../../master/access/scope.js';
import { PROJECT_STATUSES } from '../models/project.js';
import { createProject, getProject, listProjects, setProjectMembers, updateProject } from './project.service.js';

const MAX_ID_LENGTH = 100;
const MAX_NAME_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 5000;
const MAX_MEMBERS = 500;

const personIdField = z.string().min(1, 'is required').max(MAX_ID_LENGTH);
const nameField = z.string().trim().min(1, 'is required').max(MAX_NAME_LENGTH);
const descriptionField = z.string().max(MAX_DESCRIPTION_LENGTH);
const hoursField = z.number().min(0, 'can not be below zero');
const dateField = z.iso.date('must be a date, such as 2026-12-01').transform((value) => new Date(value));
const versionField = z.number().int().min(0);

const listQuerySchema = z.object({ ...paginationQueryFields, status: z.enum(PROJECT_STATUSES).optional() });

const createBodySchema = z.strictObject({
  name: nameField,
  description: descriptionField.optional(),
  totalAllocatedHours: hoursField.optional(),
  deadline: dateField.optional(),
  leadId: personIdField.optional(),
  memberIds: z.array(personIdField).max(MAX_MEMBERS).optional(),
});

const updateBodySchema = z
  .strictObject({
    name: nameField.optional(),
    description: descriptionField.optional(),
    totalAllocatedHours: hoursField.optional(),
    deadline: dateField.optional(),
    leadId: personIdField.optional(),
    status: z.enum(PROJECT_STATUSES).optional(),
    version: versionField.optional(),
  })
  .refine(({ version: _version, ...changes }) => Object.keys(changes).length > 0, { message: 'send at least one field to change' });

const membersBodySchema = z.strictObject({ memberIds: z.array(personIdField).max(MAX_MEMBERS), version: versionField.optional() });

const handleList: RequestHandler = async (req, res) => {
  res.json(await listProjects(getActor(req), scopeOf(req), parseRequestQuery(listQuerySchema, req.query)));
};

const handleGet: RequestHandler = async (req, res) => {
  res.json(await getProject(getActor(req), scopeOf(req), String(req.params.id)));
};

const handleCreate: RequestHandler = async (req, res) => {
  res.status(201).json(await createProject(getActor(req), scopeOf(req), parseRequestBody(createBodySchema, req.body)));
};

const handleUpdate: RequestHandler = async (req, res) => {
  res.json(await updateProject(getActor(req), scopeOf(req), String(req.params.id), parseRequestBody(updateBodySchema, req.body)));
};

const handleSetMembers: RequestHandler = async (req, res) => {
  res.json(await setProjectMembers(getActor(req), scopeOf(req), String(req.params.id), parseRequestBody(membersBodySchema, req.body)));
};

export const projectRoutes: ApiRoute[] = [
  { method: 'GET', path: '/tasks/projects', access: 'private', permission: 'project.read', handler: handleList },
  { method: 'POST', path: '/tasks/projects', access: 'private', permission: 'project.create', handler: handleCreate },
  { method: 'GET', path: '/tasks/projects/:id', access: 'private', permission: 'project.read', handler: handleGet },
  { method: 'PATCH', path: '/tasks/projects/:id', access: 'private', permission: 'project.update', handler: handleUpdate },
  { method: 'PUT', path: '/tasks/projects/:id/members', access: 'private', permission: 'project.update', handler: handleSetMembers },
];
