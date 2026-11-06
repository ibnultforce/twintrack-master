import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { Config } from '../../../config.js';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { parseRequestBody } from '../../../lib/validation.js';
import { getActor } from '../access/caller.js';
import { importModuleFromRequest, listRegisteredModules, listRoleTemplates, removeModule } from './moduleRegistry.service.js';
import { addRole, removeResource, removeRole, saveResource, setGrantableActions, updateRoleTemplate } from './permissionRules.service.js';

const MAX_NAME_LENGTH = 100;
const MAX_ROLE_DESCRIPTION_LENGTH = 500;

const roleNameField = z.string().trim().min(1, 'is required').max(MAX_NAME_LENGTH);
const roleDescriptionField = z.string().trim().max(MAX_ROLE_DESCRIPTION_LENGTH);
// The grants themselves are checked by the manifest rules, which give better messages than a schema here could.
const roleGrantsField = z.union([z.literal('*'), z.record(z.string(), z.unknown())]);

const addRoleBodySchema = z.strictObject({
  key: z.string().min(1, 'is required'),
  name: roleNameField,
  description: roleDescriptionField.optional(),
  grants: roleGrantsField,
});

const updateRoleBodySchema = z
  .strictObject({
    name: roleNameField.optional(),
    description: roleDescriptionField.optional(),
    grants: roleGrantsField.optional(),
  })
  .refine((changes) => Object.keys(changes).length > 0, { message: 'send at least one field to change' });

const saveResourceBodySchema = z.strictObject({
  label: roleNameField,
  actions: z.array(z.string()).min(1, 'needs at least one action'),
  scoped: z.boolean().optional(),
});

const setGrantableBodySchema = z.strictObject({ actions: z.array(z.string()) });

export function createModuleRegistryRoutes(config: Config): ApiRoute[] {
  const handleListModules: RequestHandler = async (_req, res) => {
    res.json({ modules: await listRegisteredModules(config.moduleFrontendUrls) });
  };

  const handleImportModule: RequestHandler = async (req, res) => {
    const imported = await importModuleFromRequest(getActor(req), req.body, config.moduleFrontendUrls);
    res.status(imported.created ? 201 : 200).json(imported);
  };

  const handleRemoveModule: RequestHandler = async (req, res) => {
    res.json(await removeModule(getActor(req), String(req.params.key)));
  };

  const handleListRoles: RequestHandler = async (_req, res) => {
    res.json({ roles: await listRoleTemplates() });
  };

  const handleAddRole: RequestHandler = async (req, res) => {
    const newRole = parseRequestBody(addRoleBodySchema, req.body);
    res.status(201).json(await addRole(getActor(req), String(req.params.module), newRole));
  };

  const handleUpdateRole: RequestHandler = async (req, res) => {
    const changes = parseRequestBody(updateRoleBodySchema, req.body);
    res.json(await updateRoleTemplate(getActor(req), String(req.params.module), String(req.params.key), changes));
  };

  const handleRemoveRole: RequestHandler = async (req, res) => {
    res.json(await removeRole(getActor(req), String(req.params.module), String(req.params.key)));
  };

  const handleSaveResource: RequestHandler = async (req, res) => {
    const details = parseRequestBody(saveResourceBodySchema, req.body);
    const saved = await saveResource(getActor(req), String(req.params.key), String(req.params.resource), details);
    res.status(saved.created ? 201 : 200).json(saved);
  };

  const handleRemoveResource: RequestHandler = async (req, res) => {
    res.json(await removeResource(getActor(req), String(req.params.key), String(req.params.resource)));
  };

  const handleSetGrantable: RequestHandler = async (req, res) => {
    const { actions } = parseRequestBody(setGrantableBodySchema, req.body);
    res.json(await setGrantableActions(getActor(req), String(req.params.key), String(req.params.resource), actions));
  };

  const editsRules = { access: 'private', permission: 'role.update' } as const;
  return [
    { method: 'GET', path: '/modules', access: 'private', permission: 'module.read', handler: handleListModules },
    { method: 'POST', path: '/modules/import', access: 'private', permission: 'module.create', handler: handleImportModule },
    { method: 'DELETE', path: '/modules/:key', access: 'private', permission: 'module.delete', handler: handleRemoveModule },
    { method: 'PUT', path: '/modules/:key/resources/:resource', ...editsRules, handler: handleSaveResource },
    { method: 'DELETE', path: '/modules/:key/resources/:resource', ...editsRules, handler: handleRemoveResource },
    { method: 'PUT', path: '/modules/:key/resources/:resource/grantable', ...editsRules, handler: handleSetGrantable },
    { method: 'GET', path: '/roles', access: 'private', permission: 'role.read', handler: handleListRoles },
    { method: 'POST', path: '/roles/:module', ...editsRules, handler: handleAddRole },
    { method: 'PATCH', path: '/roles/:module/:key', ...editsRules, handler: handleUpdateRole },
    { method: 'DELETE', path: '/roles/:module/:key', ...editsRules, handler: handleRemoveRole },
  ];
}
