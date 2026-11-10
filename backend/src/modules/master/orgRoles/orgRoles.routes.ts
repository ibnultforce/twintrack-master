import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { parseRequestBody } from '../../../lib/validation.js';
import { getActor } from '../access/caller.js';
import { createOrgRole, deleteOrgRole, listOrgRoles, updateOrgRole } from './orgRoles.service.js';

const MAX_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 500;

const nameField = z.string().trim().min(1, 'is required').max(MAX_NAME_LENGTH);
const descriptionField = z.string().trim().min(1).max(MAX_DESCRIPTION_LENGTH);
const orgRoleIdField = z.string().min(1, 'is required');

const createOrgRoleBodySchema = z.strictObject({
  name: nameField,
  description: descriptionField.optional(),
  parentId: orgRoleIdField.optional(),
});

// A parent can't be cleared: only the root has none, and there is one root.
const updateOrgRoleBodySchema = z
  .strictObject({
    name: nameField.optional(),
    description: descriptionField.nullable().optional(),
    parentId: orgRoleIdField.optional(),
  })
  .refine((changes) => Object.keys(changes).length > 0, { message: 'send at least one field to change' });

const orgRoleIdFrom = (params: Record<string, unknown>) => String(params.id);

const handleListOrgRoles: RequestHandler = async (_req, res) => {
  res.json({ orgRoles: await listOrgRoles() });
};

const handleCreateOrgRole: RequestHandler = async (req, res) => {
  res.status(201).json(await createOrgRole(getActor(req), parseRequestBody(createOrgRoleBodySchema, req.body)));
};

const handleUpdateOrgRole: RequestHandler = async (req, res) => {
  const changes = parseRequestBody(updateOrgRoleBodySchema, req.body);
  res.json(await updateOrgRole(getActor(req), orgRoleIdFrom(req.params), changes));
};

const handleDeleteOrgRole: RequestHandler = async (req, res) => {
  await deleteOrgRole(getActor(req), orgRoleIdFrom(req.params));
  res.status(204).end();
};

export const orgRolesRoutes: ApiRoute[] = [
  { method: 'GET', path: '/org-roles', access: 'private', permission: 'orgRole.read', handler: handleListOrgRoles },
  { method: 'POST', path: '/org-roles', access: 'private', permission: 'orgRole.create', handler: handleCreateOrgRole },
  { method: 'PATCH', path: '/org-roles/:id', access: 'private', permission: 'orgRole.update', handler: handleUpdateOrgRole },
  { method: 'DELETE', path: '/org-roles/:id', access: 'private', permission: 'orgRole.delete', handler: handleDeleteOrgRole },
];
