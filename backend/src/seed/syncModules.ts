import { prepareCollections, runInTransaction } from '../db.js';
import { ValidationFailure } from '../lib/validation.js';
import { appModels } from '../modules/models.js';
import { validateManifest, type Manifest, type ManifestResource, type ManifestRole } from '../modules/master/moduleRegistry/manifest.js';
import { findModuleByKey, updateModulePermissionRules } from '../modules/master/moduleRegistry/moduleRegistry.repository.js';
import { importManifest } from '../modules/master/moduleRegistry/moduleRegistry.service.js';

export interface SyncedModule {
  key: string;
  version: string;
  keptRoles: string[];
  /** Permissions dropped from kept roles because the manifest no longer offers them, as "role: permission". */
  droppedPermissions: string[];
}

/** Keeps only the parts of a role that the manifest's resources still offer. */
function fitRoleToResources(role: ManifestRole, resources: ManifestResource[]): { role: ManifestRole; dropped: string[] } {
  if (role.grants === '*') return { role, dropped: [] };

  const grants: Exclude<ManifestRole['grants'], '*'> = {};
  const dropped: string[] = [];
  for (const [resourceKey, grant] of Object.entries(role.grants)) {
    const offered: readonly string[] = resources.find((resource) => resource.key === resourceKey)?.actions ?? [];
    const actions = grant.actions.filter((action) => offered.includes(action));
    dropped.push(...grant.actions.filter((action) => !offered.includes(action)).map((action) => `${role.key}: ${resourceKey}.${action}`));
    if (actions.length > 0) grants[resourceKey] = { ...grant, actions };
  }
  return { role: { ...role, grants }, dropped };
}

/**
 * Loads the manifest files into the modules without touching people. Resources and routes come from the files.
 * Roles created in the app are kept, because the files ship with none.
 */
export async function syncModules(rawManifests: unknown[]): Promise<SyncedModule[]> {
  const manifests = rawManifests.map((raw, index) => {
    const result = validateManifest(raw);
    if (!result.ok) throw new ValidationFailure(`Manifest ${index + 1} is invalid`, result.errors);
    return result.value;
  });
  await prepareCollections(appModels);

  return runInTransaction(async (session) => {
    const synced: SyncedModule[] = [];
    for (const manifest of manifests) {
      const existing = await findModuleByKey(manifest.module.key, session);
      const fileRoleKeys = new Set(manifest.roles.map((role) => role.key));
      const fitted = (existing?.roles ?? [])
        .filter((role) => !fileRoleKeys.has(role.key))
        .map((role) => fitRoleToResources(role, manifest.resources));
      const merged: Manifest = { ...manifest, roles: [...manifest.roles, ...fitted.map(({ role }) => role)] };

      await importManifest(merged, { allowCore: true, session });
      // Importing clears the edited mark, but kept roles are still edits that an import shouldn't quietly replace.
      if (fitted.length > 0) await updateModulePermissionRules(manifest.module.key, {}, session);
      synced.push({
        key: manifest.module.key,
        version: manifest.module.version,
        keptRoles: fitted.map(({ role }) => role.key),
        droppedPermissions: fitted.flatMap(({ dropped }) => dropped),
      });
    }
    return synced;
  });
}
