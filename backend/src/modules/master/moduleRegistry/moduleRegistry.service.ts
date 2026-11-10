import { isDeepStrictEqual } from 'node:util';
import type { ClientSession } from 'mongoose';
import { runInTransaction } from '../../../db.js';
import { ApiError } from '../../../lib/errors.js';
import { actorFields, type Actor } from '../access/caller.js';
import { findAllProfiles } from '../accessProfiles/accessProfiles.repository.js';
import { recordAudit } from '../audit/audit.repository.js';
import type { ModuleDoc } from '../models/module.js';
import { countUsersWithPermissionSetsIn, countUsersWithPermissionSetOutside } from '../users/users.repository.js';
import { validateManifest, type Manifest } from './manifest.js';
import { deleteModule, findAllModules, findModuleByKey, saveModule } from './moduleRegistry.repository.js';
import { canDoToPermissionSetsIn, listPermissionApis, listPermissionUsers } from './permissionSetEditing.js';

export class CoreModuleError extends ApiError {
  constructor(key: string, problem: string) {
    super(403, 'core_module', `Module "${key}" is a core module and can't be ${problem}.`);
  }
}

export interface ImportResult {
  key: string;
  version: string;
  created: boolean;
  /** People holding a permission set this module no longer has. It gives them nothing until it's added again. */
  orphanedPermissionSets: number;
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

/** Someone who can't edit a module's resources and permission sets mustn't undo those edits by importing or removing the module. */
function assertMayReplaceEdits(actor: Actor, module: ModuleDoc | null): void {
  if (!module?.permissionsEditedAt || actor.user.superAdmin) return;
  if (!actor.permissions['module.update'] || !canDoToPermissionSetsIn(actor, module, 'update')) {
    throw new ApiError(409, 'permissions_edited', `${module.name}'s permissions have been edited, so replacing or removing it needs module.update and permissionSet.update in that module.`);
  }
}

const addsOrChangesPermissionSets = (manifest: Manifest, existing: ModuleDoc | null) =>
  manifest.permissionSets.some((permissionSet) => {
    const existingSet = existing?.permissionSets.find((candidate) => candidate.key === permissionSet.key);
    return !existingSet || !isDeepStrictEqual(permissionSet.grants, existingSet.grants);
  });

/** An import mustn't do what the permission set routes refuse, and removing a module first mustn't get around that. */
function assertMayImportOver(actor: Actor, manifest: Manifest, existing: ModuleDoc | null): void {
  if (actor.user.superAdmin) return;
  assertMayReplaceEdits(actor, existing);
  if (addsOrChangesPermissionSets(manifest, existing)) {
    throw new ApiError(403, 'beyond_own_access', 'Only a super admin can import a manifest that adds or changes permission sets.');
  }
}

/** Saves a validated manifest. Only the seed may set up core modules, so the API can't replace Master's own rules. */
export async function importManifest(
  manifest: Manifest,
  options: { allowCore?: boolean; assertMayReplace?: (existing: ModuleDoc | null) => void; session?: ClientSession } = {},
): Promise<ImportResult> {
  const { allowCore = false, assertMayReplace, session } = options;
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
  const created = await saveModule({ ...manifest, resources: [...manifest.resources, ...customResources] }, isCore, session);
  const setKeys = manifest.permissionSets.map((permissionSet) => permissionSet.key);
  const orphanedPermissionSets = await countUsersWithPermissionSetOutside(key, setKeys, session);

  return { key, version, created, orphanedPermissionSets };
}

function toRegisteredModule(
  module: Pick<RegisteredModule, 'key' | 'name' | 'version' | 'description'> & { core?: boolean },
  frontendUrls: Map<string, string>,
): RegisteredModule {
  return {
    key: module.key,
    name: module.name,
    version: module.version,
    description: module.description,
    core: module.core ?? false,
    frontendUrl: frontendUrls.get(module.key) ?? null,
  };
}

export async function listRegisteredModules(frontendUrls: Map<string, string>) {
  const [modules, profiles] = await Promise.all([findAllModules(), findAllProfiles()]);
  return modules.map((module) => ({
    ...toRegisteredModule(module, frontendUrls),
    resources: module.resources,
    apis: listPermissionApis(module),
    usedBy: listPermissionUsers(module, profiles),
  }));
}

/** Checks a manifest sent to the API and saves it. Importing a module again replaces it. */
export async function importModuleFromRequest(
  actor: Actor,
  rawManifest: unknown,
  frontendUrls: Map<string, string>,
): Promise<RegisteredModule & ImportResult> {
  const validated = validateManifest(rawManifest);
  if (!validated.ok) throw new ApiError(422, 'validation_failed', 'That manifest is invalid.', validated.errors);
  const manifest = validated.value;

  const result = await runInTransaction(async (session) => {
    const previousVersion = (await findModuleByKey(manifest.module.key, session))?.version ?? null;
    const imported = await importManifest(manifest, { assertMayReplace: (existing) => assertMayImportOver(actor, manifest, existing), session });
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
    return imported;
  });
  return { ...toRegisteredModule(manifest.module, frontendUrls), ...result };
}

/** A manifest of the module as it stands, including edits made in the app, in the form an import accepts. */
export async function exportModuleManifest(key: string) {
  const module = await findModuleByKey(key);
  if (!module) throw new ApiError(404, 'unknown_module', 'No such module.');
  const { name, version, description, repository, baseUrl, core, resources, routes, permissionSets } = module;
  return {
    manifestVersion: 1,
    module: { key, name, version, description, repository, baseUrl, ...(core && { core }) },
    resources,
    routes,
    permissionSets,
  };
}

/** People keep their permission sets in a removed module, and profiles keep their part for it. Neither grants anything unless it's imported again. */
export async function removeModule(actor: Actor, key: string): Promise<{ removed: true; key: string; affectedUsers: number }> {
  const module = await findModuleByKey(key);
  if (!module) throw new ApiError(404, 'unknown_module', 'No such module.');
  if (module.core) throw new CoreModuleError(key, 'removed');
  assertMayReplaceEdits(actor, module);

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
    return countUsersWithPermissionSetsIn(key, session);
  });
  return { removed: true, key, affectedUsers };
}
