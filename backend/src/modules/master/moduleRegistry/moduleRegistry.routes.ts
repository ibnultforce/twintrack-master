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
import { exportModuleManifest, importModuleFromRequest, listRegisteredModules, removeModule } from './moduleRegistry.service.js';
import {
  addPermissionSet,
  canReachPermissionSetsSomewhere,
  listManageablePermissionSets,
  removePermissionSet,
  removeResource,
  saveResource,
  updatePermissionSet,
} from './permissionRules.service.js';

const MAX_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 500;

const nameField = z.string().trim().min(1, 'is required').max(MAX_NAME_LENGTH);
const descriptionField = z.string().trim().max(MAX_DESCRIPTION_LENGTH);
// The grants themselves are checked by the manifest rules, which give better messages than a schema here could.
const grantsField = z.union([z.literal('*'), z.record(z.string(), z.unknown())]);

const addPermissionSetBodySchema = z.strictObject({
  key: z.string().min(1, 'is required'),
  name: nameField,
  description: descriptionField.optional(),
  grants: grantsField,
});

const updatePermissionSetBodySchema = z
  .strictObject({
    name: nameField.optional(),
    description: descriptionField.optional(),
    grants: grantsField.optional(),
  })
  .refine((changes) => Object.keys(changes).length > 0, { message: 'send at least one field to change' });

const saveResourceBodySchema = z.strictObject({
  label: nameField,
  actions: z.array(z.string()).min(1, 'needs at least one action'),
  scoped: z.boolean().optional(),
});

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

  const handleAddPermissionSet: RequestHandler = async (req, res) => {
    const newSet = parseRequestBody(addPermissionSetBodySchema, req.body);
    res.status(201).json(await addPermissionSet(getSignedActor(req), String(req.params.module), newSet));
  };

  const handleUpdatePermissionSet: RequestHandler = async (req, res) => {
    const changes = parseRequestBody(updatePermissionSetBodySchema, req.body);
    res.json(await updatePermissionSet(getSignedActor(req), String(req.params.module), String(req.params.key), changes));
  };

  const handleRemovePermissionSet: RequestHandler = async (req, res) => {
    res.json(await removePermissionSet(getSignedActor(req), String(req.params.module), String(req.params.key)));
  };

  const handleSaveResource: RequestHandler = async (req, res) => {
    const details = parseRequestBody(saveResourceBodySchema, req.body);
    const saved = await saveResource(getActor(req), String(req.params.key), String(req.params.resource), details);
    res.status(saved.created ? 201 : 200).json(saved);
  };

  const handleRemoveResource: RequestHandler = async (req, res) => {
    res.json(await removeResource(getActor(req), String(req.params.key), String(req.params.resource)));
  };

  const handleListPermissionSets: RequestHandler = async (req, res) => {
    res.json({ modules: await listManageablePermissionSets(getSignedActor(req)) });
  };

  // Signed, because the right to edit permission sets is held per module. The service decides which modules this person can edit.
  const editsPermissionSets = { access: 'signed' as const, middleware: [refuseUnless(canReachPermissionSetsSomewhere)] };
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
    // One route both adds and changes a resource. The service picks the permission once it knows whether the resource exists.
    { method: 'PUT', path: '/modules/:key/resources/:resource', access: 'private', anyPermission: ['module.create', 'module.update'], handler: handleSaveResource },
    { method: 'DELETE', path: '/modules/:key/resources/:resource', access: 'private', permission: 'module.delete', handler: handleRemoveResource },
    { method: 'GET', path: '/permission-sets', ...editsPermissionSets, handler: handleListPermissionSets },
    { method: 'POST', path: '/permission-sets/:module', ...editsPermissionSets, handler: handleAddPermissionSet },
    { method: 'PATCH', path: '/permission-sets/:module/:key', ...editsPermissionSets, handler: handleUpdatePermissionSet },
    { method: 'DELETE', path: '/permission-sets/:module/:key', ...editsPermissionSets, handler: handleRemovePermissionSet },
  ];
}
