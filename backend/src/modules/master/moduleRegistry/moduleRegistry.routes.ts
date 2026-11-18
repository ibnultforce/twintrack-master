import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { Config } from '../../../config.js';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { paginationQueryFields } from '../../../lib/query.js';
import { parseRequestBody, parseRequestQuery } from '../../../lib/validation.js';
import { getActor } from '../access/caller.js';
import { assertOwnPassword } from '../auth/account.service.js';
import { createFailedAttemptLimiter } from '../auth/failedAttemptLimiter.js';
import { MAX_PASSWORD_LENGTH } from '../auth/passwords.js';
import { exportModuleManifest, importModuleFromRequest, listRegisteredModules, removeModule } from './moduleRegistry.service.js';
import type { AllowedOrigins } from './allowedOrigins.js';
import type { ModuleFiles } from './moduleFiles.js';
import { MAX_ALLOWED_ORIGINS, MAX_REDIRECT_URLS, saveFrontendSettings } from './frontendSettings.service.js';
import { listModuleChanges, markModuleChangeDone, MODULE_CHANGE_STATUSES } from './moduleChanges.service.js';
import { listModulePackFiles, readModulePackFile } from './modulePacks.service.js';
import { getModuleSchema, importModuleSchema } from './moduleSchema.service.js';
import { removeResource, saveResource } from './permissionRules.service.js';
import { changeRouteAccess } from './routeAccess.service.js';

const MAX_NAME_LENGTH = 100;
const MAX_PACK_PATH_LENGTH = 200;
const MAX_URL_LENGTH = 2000;

const urlField = z.string().trim().min(1, 'is required').max(MAX_URL_LENGTH);

// The addresses are checked by the service, which gives a message for each one.
const frontendSettingsBodySchema = z.strictObject({
  frontendUrl: urlField.nullable(),
  redirectUrls: z.array(urlField).max(MAX_REDIRECT_URLS),
  allowedOrigins: z.array(urlField).max(MAX_ALLOWED_ORIGINS),
});

const nameField = z.string().trim().min(1, 'is required').max(MAX_NAME_LENGTH);

const saveResourceBodySchema = z.strictObject({
  label: nameField,
  actions: z.array(z.string()).min(1, 'needs at least one action'),
  scoped: z.boolean().optional(),
});

const routeAccessBodySchema = z.strictObject({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().startsWith('/').max(300),
  access: z.enum(['public', 'signed', 'private']),
  permission: z.string().trim().min(1).max(MAX_NAME_LENGTH).optional(),
});

// The manifest is checked by the manifest rules, which give better messages than a schema here could.
const importModuleBodySchema = z.strictObject({
  password: z.string().min(1, 'is required').max(MAX_PASSWORD_LENGTH),
  manifest: z.unknown(),
});

// The schema itself is checked by the service, against the data model rules.
const importSchemaBodySchema = z.strictObject({
  schema: z.unknown(),
});

const changesQuerySchema = z.object({ ...paginationQueryFields, status: z.enum(MODULE_CHANGE_STATUSES).optional() });

const packFileQuerySchema = z.object({
  path: z.string().trim().min(1, 'is required').max(MAX_PACK_PATH_LENGTH),
});

export function createModuleRegistryRoutes(config: Config, allowedOrigins: AllowedOrigins, moduleFiles: ModuleFiles): ApiRoute[] {
  const handleListModules: RequestHandler = async (_req, res) => {
    res.json({ modules: await listRegisteredModules(config.moduleFrontendUrls) });
  };

  const handleImportModule: RequestHandler = async (req, res) => {
    const { password, manifest } = parseRequestBody(importModuleBodySchema, req.body);
    const actor = getActor(req);
    await assertOwnPassword(actor.user._id, password);
    const imported = await importModuleFromRequest(actor, manifest, config.moduleFrontendUrls, moduleFiles);
    res.status(imported.created ? 201 : 200).json(imported);
  };

  const handleExportModule: RequestHandler = async (req, res) => {
    res.json(await exportModuleManifest(String(req.params.key)));
  };

  const handleGetSchema: RequestHandler = async (req, res) => {
    res.json(await getModuleSchema(String(req.params.key)));
  };

  const handleImportSchema: RequestHandler = async (req, res) => {
    const { schema } = parseRequestBody(importSchemaBodySchema, req.body);
    res.json(await importModuleSchema(getActor(req), String(req.params.key), schema, moduleFiles));
  };

  const handleListChanges: RequestHandler = async (req, res) => {
    res.json(await listModuleChanges(String(req.params.key), parseRequestQuery(changesQuerySchema, req.query)));
  };

  const handleMarkChangeDone: RequestHandler = async (req, res) => {
    res.json(await markModuleChangeDone(getActor(req), String(req.params.key), String(req.params.changeId), moduleFiles));
  };

  const handleListPackFiles: RequestHandler = async (req, res) => {
    res.json({ files: await listModulePackFiles(String(req.params.key)) });
  };

  const handleDownloadPackFile: RequestHandler = async (req, res) => {
    const { path } = parseRequestQuery(packFileQuerySchema, req.query);
    const file = await readModulePackFile(String(req.params.key), path);
    res.attachment(file.path.split('/').pop()).type('application/octet-stream').send(file.content);
  };

  const handleSaveFrontendSettings: RequestHandler = async (req, res) => {
    const request = parseRequestBody(frontendSettingsBodySchema, req.body);
    const options = { isProduction: config.nodeEnv === 'production', environmentUrls: config.moduleFrontendUrls };
    const saved = await saveFrontendSettings(getActor(req), String(req.params.key), request, options);
    allowedOrigins.forget();
    res.json({ frontendSettings: saved });
  };

  const handleRemoveModule: RequestHandler = async (req, res) => {
    res.json(await removeModule(getActor(req), String(req.params.key), moduleFiles));
  };


  const handleSaveResource: RequestHandler = async (req, res) => {
    const details = parseRequestBody(saveResourceBodySchema, req.body);
    const saved = await saveResource(getActor(req), String(req.params.key), String(req.params.resource), details);
    res.status(saved.created ? 201 : 200).json(saved);
  };

  const handleRemoveResource: RequestHandler = async (req, res) => {
    res.json(await removeResource(getActor(req), String(req.params.key), String(req.params.resource)));
  };

  const handleChangeRouteAccess: RequestHandler = async (req, res) => {
    const request = parseRequestBody(routeAccessBodySchema, req.body);
    res.json({ route: await changeRouteAccess(getActor(req), String(req.params.key), request) });
  };

  return [
    { method: 'GET', path: '/modules', access: 'private', permission: 'module.read', handler: handleListModules },
    {
      method: 'POST',
      path: '/modules/import',
      access: 'private',
      permission: 'module.create',
      middleware: [createFailedAttemptLimiter(config.auth, 'import-manifest')],
      bodySchema: importModuleBodySchema, handler: handleImportModule,
    },
    { method: 'GET', path: '/modules/:key/export', access: 'private', permission: 'module.read', handler: handleExportModule },
    { method: 'GET', path: '/modules/:key/schema', access: 'private', permission: 'module.read', handler: handleGetSchema },
    { method: 'PUT', path: '/modules/:key/schema', access: 'private', permission: 'module.update', bodySchema: importSchemaBodySchema, handler: handleImportSchema },
    { method: 'GET', path: '/modules/:key/changes', access: 'private', permission: 'module.read', handler: handleListChanges },
    { method: 'POST', path: '/modules/:key/changes/:changeId/done', access: 'private', permission: 'module.update', handler: handleMarkChangeDone },
    { method: 'GET', path: '/modules/:key/pack',access: 'private', permission: 'module.read', handler: handleListPackFiles },
    { method: 'GET', path: '/modules/:key/pack/file', access: 'private', permission: 'module.read', handler: handleDownloadPackFile },
    // Only a super admin may, which the service checks: whoever controls a redirect address receives people's sign-ins.
    { method: 'PUT', path: '/modules/:key/frontend', access: 'private', permission: 'module.update', bodySchema: frontendSettingsBodySchema, handler: handleSaveFrontendSettings },
    { method: 'DELETE', path: '/modules/:key', access: 'private', permission: 'module.delete', handler: handleRemoveModule },
    // One route both adds and changes a resource. The service picks the permission once it knows whether the resource exists.
    { method: 'PUT', path: '/modules/:key/resources/:resource', access: 'private', anyPermission: ['module.create', 'module.update'], bodySchema: saveResourceBodySchema, handler: handleSaveResource },
    // Only a super admin may, which the service checks: it changes access for everyone.
    { method: 'PUT', path: '/modules/:key/route-access', access: 'private', permission: 'module.update', bodySchema: routeAccessBodySchema, handler: handleChangeRouteAccess },
    { method: 'DELETE', path: '/modules/:key/resources/:resource', access: 'private', permission: 'module.delete', handler: handleRemoveResource },
  ];
}
