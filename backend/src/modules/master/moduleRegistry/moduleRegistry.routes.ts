import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { Config } from '../../../config.js';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { parseRequestBody } from '../../../lib/validation.js';
import { getActor, getSignedActor } from '../access/caller.js';
import { refuseUnless } from '../access/refuseUnless.js';
import { assertOwnPassword } from '../auth/account.service.js';
import { createFailedAttemptLimiter } from '../auth/failedAttemptLimiter.js';
import { MAX_PASSWORD_LENGTH } from '../auth/passwords.js';
import { exportModuleManifest, importModuleFromRequest, listRegisteredModules, listRoleTemplates, removeModule } from './moduleRegistry.service.js';
import { addRole, canEditRolesSomewhere, listManageableRoles, removeResource, removeRole, saveResource, setGrantableActions, updateRoleTemplate } from './permissionRules.service.js';

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

// The manifest is checked by the manifest rules, which give better messages than a schema here could.
const importModuleBodySchema = z.strictObject({
  password: z.string().min(1, 'is required').max(MAX_PASSWORD_LENGTH),
  manifest: z.unknown(),
});

export function createModuleRegistryRoutes(config: Config): ApiRoute[] {
  const handleListModules: RequestHandler = async (_req, res) => {
    res.json({ modules: await listRegisteredModules(config.moduleFrontendUrls) });
  };

  const handleImportModule: RequestHandler = async (req, res) => {
    const { password, manifest } = parseRequestBody(importModuleBodySchema, req.body);
    const actor = getActor(req);
    await assertOwnPassword(actor.user._id, password);
    const imported = await importModuleFromRequest(actor, manifest, config.moduleFrontendUrls);
    res.status(imported.created ? 201 : 200).json(imported);
  };

  const handleExportModule: RequestHandler = async (req, res) => {
    res.json(await exportModuleManifest(String(req.params.key)));
  };

  const handleRemoveModule: RequestHandler = async (req, res) => {
    res.json(await removeModule(getActor(req), String(req.params.key)));
  };

  const handleListRoles: RequestHandler = async (_req, res) => {
    res.json({ roles: await listRoleTemplates() });
  };

  const handleAddRole: RequestHandler = async (req, res) => {
    const newRole = parseRequestBody(addRoleBodySchema, req.body);
    res.status(201).json(await addRole(getSignedActor(req), String(req.params.module), newRole));
  };

  const handleUpdateRole: RequestHandler = async (req, res) => {
    const changes = parseRequestBody(updateRoleBodySchema, req.body);
    res.json(await updateRoleTemplate(getSignedActor(req), String(req.params.module), String(req.params.key), changes));
  };

  const handleRemoveRole: RequestHandler = async (req, res) => {
    res.json(await removeRole(getSignedActor(req), String(req.params.module), String(req.params.key)));
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

  const handleListManageableRoles: RequestHandler = async (req, res) => {
    res.json({ modules: await listManageableRoles(getSignedActor(req)) });
  };

  const editsResources = { access: 'private', permission: 'module.update' } as const;
  // Signed, because the right to edit roles is held per module. The service decides which modules this person can edit.
  const editsRoles = { access: 'signed' as const, middleware: [refuseUnless(canEditRolesSomewhere)] };
  return [
    { method: 'GET', path: '/modules', access: 'private', permission: 'module.read', handler: handleListModules },
    {
      method: 'POST',
      path: '/modules/import',
      access: 'private',
      permission: 'module.create',
      middleware: [createFailedAttemptLimiter(config.auth, 'import-manifest')],
      handler: handleImportModule,
    },
    { method: 'GET', path: '/modules/:key/export', access: 'private', permission: 'module.read', handler: handleExportModule },
    { method: 'DELETE', path: '/modules/:key', access: 'private', permission: 'module.delete', handler: handleRemoveModule },
    { method: 'PUT', path: '/modules/:key/resources/:resource', ...editsResources, handler: handleSaveResource },
    { method: 'DELETE', path: '/modules/:key/resources/:resource', ...editsResources, handler: handleRemoveResource },
    { method: 'PUT', path: '/modules/:key/resources/:resource/grantable', ...editsResources, handler: handleSetGrantable },
    { method: 'GET', path: '/roles/manageable', ...editsRoles, handler: handleListManageableRoles },
    { method: 'GET', path: '/roles', access: 'private', permission: 'role.read', handler: handleListRoles },
    { method: 'POST', path: '/roles/:module', ...editsRoles, handler: handleAddRole },
    { method: 'PATCH', path: '/roles/:module/:key', ...editsRoles, handler: handleUpdateRole },
    { method: 'DELETE', path: '/roles/:module/:key', ...editsRoles, handler: handleRemoveRole },
  ];
}
