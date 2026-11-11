import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { Config } from '../../../config.js';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { parseRequestBody } from '../../../lib/validation.js';
import { getActor } from '../access/caller.js';
import { assertOwnPassword } from '../auth/account.service.js';
import { createFailedAttemptLimiter } from '../auth/failedAttemptLimiter.js';
import { MAX_PASSWORD_LENGTH } from '../auth/passwords.js';
import { exportModuleManifest, importModuleFromRequest, listRegisteredModules, removeModule } from './moduleRegistry.service.js';
import { removeResource, saveResource } from './permissionRules.service.js';

const MAX_NAME_LENGTH = 100;

const nameField = z.string().trim().min(1, 'is required').max(MAX_NAME_LENGTH);

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


  const handleSaveResource: RequestHandler = async (req, res) => {
    const details = parseRequestBody(saveResourceBodySchema, req.body);
    const saved = await saveResource(getActor(req), String(req.params.key), String(req.params.resource), details);
    res.status(saved.created ? 201 : 200).json(saved);
  };

  const handleRemoveResource: RequestHandler = async (req, res) => {
    res.json(await removeResource(getActor(req), String(req.params.key), String(req.params.resource)));
  };

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
  ];
}
