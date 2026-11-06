import type { ClientSession } from 'mongoose';
import { runInTransaction } from '../../../db.js';
import { ApiError } from '../../../lib/errors.js';
import { actorFields, type Actor } from '../access/caller.js';
import { listRolePermissions } from '../access/permissions.js';
import { recordAudit } from '../audit/audit.repository.js';
import type { ModuleDoc } from '../models/module.js';
import { countUsersWithAccessIn, countUsersWithRoleOutside } from '../users/users.repository.js';
import { validateManifest, type Manifest, type ManifestResource, type ManifestRole } from './manifest.js';
import { deleteModule, findAllModules, findModuleByKey, saveModule } from './moduleRegistry.repository.js';

const EVERYTHING_LABEL = 'Everything in this module';

export class CoreModuleError extends ApiError {
  constructor(key: string, problem: string) {
    super(403, 'core_module', `Module "${key}" is a core module and can't be ${problem}.`);
  }
}

export interface ImportResult {
  key: string;
  version: string;
  created: boolean;
  /** People whose role no longer exists in this module. They keep no access from it until reassigned. */
  orphanedAssignments: number;
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

/** Someone who can't edit a module's rules mustn't undo those edits by importing or removing the module. */
function assertMayReplaceEdits(module: Pick<ModuleDoc, 'name' | 'permissionsEditedAt'> | null, canEditRules: boolean): void {
  if (module?.permissionsEditedAt && !canEditRules) {
    throw new ApiError(409, 'permissions_edited', `${module.name}'s permissions have been edited, so replacing or removing it needs role.update.`);
  }
}

/** Saves a validated manifest. Only the seed may set up core modules, so the API can't replace Master's own rules. */
export async function importManifest(
  manifest: Manifest,
  options: { allowCore?: boolean; canEditRules?: boolean; session?: ClientSession } = {},
): Promise<ImportResult> {
  const { allowCore = false, canEditRules = false, session } = options;
  const { key, version, core: isCore = false } = manifest.module;

  if (!allowCore) {
    const existingModule = await findModuleByKey(key, session);
    if (isCore || existingModule?.core) throw new CoreModuleError(key, 'imported');
    assertMayReplaceEdits(existingModule, canEditRules);
  }

  const created = await saveModule(manifest, isCore, session);
  const roleKeys = manifest.roles.map((role) => role.key);
  const orphanedAssignments = await countUsersWithRoleOutside(key, roleKeys, session);

  return { key, version, created, orphanedAssignments };
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
  const modules = await findAllModules();
  return modules.map((module) => ({ ...toRegisteredModule(module, frontendUrls), resources: module.resources }));
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
    const imported = await importManifest(manifest, { canEditRules: Boolean(actor.permissions['role.update']), session });
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

/** People keep their role and privileges in a removed module, which grant nothing unless it's imported again. */
export async function removeModule(actor: Actor, key: string): Promise<{ removed: true; key: string; affectedUsers: number }> {
  const module = await findModuleByKey(key);
  if (!module) throw new ApiError(404, 'unknown_module', 'No such module.');
  if (module.core) throw new CoreModuleError(key, 'removed');
  assertMayReplaceEdits(module, Boolean(actor.permissions['role.update']));

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
    return countUsersWithAccessIn(key, session);
  });
  return { removed: true, key, affectedUsers };
}

export function describeRoleGrants(role: ManifestRole, resources: ManifestResource[]): string[] {
  if (role.grants === '*') return [EVERYTHING_LABEL];
  return Object.entries(listRolePermissions(role, resources)).map(([permission, scope]) =>
    scope === 'all' ? permission : `${permission} (${scope})`,
  );
}

/** The fixed role templates of every loaded module. */
export async function listRoleTemplates() {
  const modules = await findAllModules();
  return modules.flatMap((module) =>
    module.roles.map((role) => ({
      module: module.key,
      moduleName: module.name,
      key: role.key,
      name: role.name,
      description: role.description ?? '',
      grants: describeRoleGrants(role, module.resources),
      permissions: listRolePermissions(role, module.resources),
    })),
  );
}
