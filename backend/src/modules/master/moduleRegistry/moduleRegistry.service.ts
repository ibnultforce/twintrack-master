import type { ClientSession } from 'mongoose';
import { runInTransaction } from '../../../db.js';
import { ApiError } from '../../../lib/errors.js';
import { actorFields, type Actor } from '../access/caller.js';
import { findAllProfiles, findProfileIdsGranting } from '../accessProfiles/accessProfiles.repository.js';
import { recordAudit } from '../audit/audit.repository.js';
import type { ModuleDoc, ModuleFrontendSettings, ModuleSource } from '../models/module.js';
import { resolveFrontendUrl, toFrontendSettingsView } from './frontendSettings.service.js';
import { countUsersWithProfiles } from '../users/users.repository.js';
import { validateManifest, type Manifest } from './manifest.js';
import { deleteModule, findAllModules, findModuleByKey, saveModule } from './moduleRegistry.repository.js';
import { describeModuleSchema } from './moduleSchema.service.js';
import type { ChangeLogReport, ModuleFiles, ModuleFilesReport } from './moduleFiles.js';
import { diffModule } from './moduleChanges.js';
import { recordModuleChange, writeChangeLog, type ModuleChangeView } from './moduleChanges.service.js';
import { listModuleRoutes, listPermissionApis, listPermissionUsers } from './grantEditing.js';

export class CoreModuleError extends ApiError {
  constructor(key: string, problem: string) {
    super(403, 'core_module', `Module "${key}" is a core module and can't be ${problem}.`);
  }
}

export interface ImportResult {
  key: string;
  version: string;
  created: boolean;
}

export interface RegisteredModule {
  key: string;
  name: string;
  version: string;
  description?: string;
  /** A core module can't be removed or replaced. */
  core: boolean;
  frontendUrl: string | null;
}

/** Someone who can't edit a module's resources mustn't undo those edits by importing or removing the module. */
function assertMayReplaceEdits(actor: Actor, module: ModuleDoc | null): void {
  if (!module?.permissionsEditedAt || actor.user.superAdmin) return;
  if (!actor.permissions['module.update']) {
    throw new ApiError(409, 'permissions_edited', `${module.name}'s resources have been edited, so replacing or removing it needs module.update.`);
  }
}

/** Saves a validated manifest. Only the seed may set up core modules, so the API can't replace Master's own rules. */
export async function importManifest(
  manifest: Manifest,
  options: { allowCore?: boolean; source?: ModuleSource; assertMayReplace?: (existing: ModuleDoc | null) => void; session?: ClientSession } = {},
): Promise<ImportResult> {
  const { allowCore = false, source = 'app', assertMayReplace, session } = options;
  const { key, version, core: isCore = false } = manifest.module;

  if (!allowCore) {
    const existingModule = await findModuleByKey(key, session);
    if (isCore || existingModule?.core) throw new CoreModuleError(key, 'imported');
    assertMayReplace?.(existingModule);
  }

  // Custom objects are built in the app, so a manifest never lists them. Keeping them means an import can't orphan their records.
  const existing = await findModuleByKey(key, session);
  const fileResourceKeys = new Set(manifest.resources.map((resource) => resource.key));
  const customResources = (existing?.resources ?? []).filter((resource) => resource.custom === true && !fileResourceKeys.has(resource.key));
  const created = await saveModule({ ...manifest, resources: [...manifest.resources, ...customResources] }, isCore, source, session);
  return { key, version, created };
}

function toRegisteredModule(
  module: Pick<RegisteredModule, 'key' | 'name' | 'version' | 'description'> & { core?: boolean; frontendSettings?: ModuleFrontendSettings },
  frontendUrls: Map<string, string>,
): RegisteredModule {
  return {
    key: module.key,
    name: module.name,
    version: module.version,
    description: module.description,
    core: module.core ?? false,
    frontendUrl: resolveFrontendUrl(module, frontendUrls),
  };
}

export async function listRegisteredModules(frontendUrls: Map<string, string>) {
  const [modules, profiles] = await Promise.all([findAllModules(), findAllProfiles()]);
  return modules.map((module) => ({
    ...toRegisteredModule(module, frontendUrls),
    frontendSettings: toFrontendSettingsView(module, frontendUrls),
    resources: module.resources,
    schema: describeModuleSchema(module),
    apis: listPermissionApis(module),
    routes: listModuleRoutes(module),
    usedBy: listPermissionUsers(module, profiles),
  }));
}

/** Checks a manifest sent to the API and saves it. Importing a module again replaces it. */
export async function importModuleFromRequest(
  actor: Actor,
  rawManifest: unknown,
  frontendUrls: Map<string, string>,
  moduleFiles: ModuleFiles,
): Promise<RegisteredModule & ImportResult & { files: ModuleFilesReport; change: ModuleChangeView | null; changeLog: ChangeLogReport | null }> {
  const validated = validateManifest(rawManifest);
  if (!validated.ok) throw new ApiError(422, 'validation_failed', 'That manifest is invalid.', validated.errors);
  const manifest = validated.value;

  const { imported, change } = await runInTransaction(async (session) => {
    const previous = await findModuleByKey(manifest.module.key, session);
    const previousVersion = previous?.version ?? null;
    const imported = await importManifest(manifest, { assertMayReplace: (existing) => assertMayReplaceEdits(actor, existing), session });
    await recordAudit(
      {
        action: 'module.imported',
        ...actorFields(actor),
        targetType: 'module',
        targetId: imported.key,
        targetName: manifest.module.name,
        module: imported.key,
        before: { version: previousVersion },
        after: { version: imported.version },
      },
      session,
    );
    const change = await recordModuleChange(
      actor,
      {
        module: imported.key,
        moduleName: manifest.module.name,
        source: 'manifest',
        versionBefore: previousVersion,
        versionAfter: imported.version,
        items: diffModule(imported.key, previous, manifest),
      },
      session,
    );
    return { imported, change };
  });
  // Only after the transaction commits, so a refused import never touches the repo.
  const files = await moduleFiles.saveManifest(manifest);
  const changeLog = change ? await writeChangeLog(imported.key, moduleFiles) : null;
  return { ...toRegisteredModule(manifest.module, frontendUrls), ...imported, files, change, changeLog };
}

/** A manifest of the module as it stands, including edits made in the app, in the form an import accepts. */
export async function exportModuleManifest(key: string) {
  const module = await findModuleByKey(key);
  if (!module) throw new ApiError(404, 'unknown_module', 'No such module.');
  const { name, version, description, repository, baseUrl, core, resources, routes, schema } = module;
  return {
    manifestVersion: 1,
    module: { key, name, version, description, repository, baseUrl, ...(core && { core }) },
    resources,
    routes,
    ...(schema && { schema }),
  };
}

/** Profiles keep their part for a removed module, which grants nothing unless it's imported again. Counts the people whose profile covers it. */
export async function removeModule(
  actor: Actor,
  key: string,
  moduleFiles: ModuleFiles,
): Promise<{ removed: true; key: string; affectedUsers: number; files: ModuleFilesReport }> {
  const module = await findModuleByKey(key);
  if (!module) throw new ApiError(404, 'unknown_module', 'No such module.');
  if (module.core) throw new CoreModuleError(key, 'removed');
  assertMayReplaceEdits(actor, module);

  const profileIds = await findProfileIdsGranting(key);
  const affectedUsers = await runInTransaction(async (session) => {
    await deleteModule(key, session);
    await recordAudit(
      {
        action: 'module.removed',
        ...actorFields(actor),
        targetType: 'module',
        targetId: key,
        targetName: module.name,
        module: key,
        before: { version: module.version },
      },
      session,
    );
    return countUsersWithProfiles(profileIds, session);
  });
  return { removed: true, key, affectedUsers, files: await moduleFiles.removeModule(key) };
}
