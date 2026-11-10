import { prepareCollections, runInTransaction } from '../db.js';
import { ValidationFailure } from '../lib/validation.js';
import { appModels } from '../modules/models.js';
import { validateManifest, type Manifest, type ManifestPermissionSet, type ManifestResource } from '../modules/master/moduleRegistry/manifest.js';
import { findModuleByKey, updateModulePermissionRules } from '../modules/master/moduleRegistry/moduleRegistry.repository.js';
import { importManifest } from '../modules/master/moduleRegistry/moduleRegistry.service.js';

export interface SyncedModule {
  key: string;
  version: string;
  keptPermissionSets: string[];
  /** Permissions dropped from kept permission sets because the manifest no longer offers them, as "set: permission". */
  droppedPermissions: string[];
}

/** Keeps only the parts of a permission set that the manifest's resources still offer. */
function fitSetToResources(permissionSet: ManifestPermissionSet, resources: ManifestResource[]): { permissionSet: ManifestPermissionSet; dropped: string[] } {
  if (permissionSet.grants === '*') return { permissionSet, dropped: [] };

  const grants: Exclude<ManifestPermissionSet['grants'], '*'> = {};
  const dropped: string[] = [];
  for (const [resourceKey, grant] of Object.entries(permissionSet.grants)) {
    const offered: readonly string[] = resources.find((resource) => resource.key === resourceKey)?.actions ?? [];
    const actions = grant.actions.filter((action) => offered.includes(action));
    dropped.push(...grant.actions.filter((action) => !offered.includes(action)).map((action) => `${permissionSet.key}: ${resourceKey}.${action}`));
    if (actions.length > 0) grants[resourceKey] = { ...grant, actions };
  }
  return { permissionSet: { ...permissionSet, grants }, dropped };
}

/**
 * Loads the manifest files into the modules without touching people. Resources and routes come from the files.
 * Permission sets created in the app are kept, because the files ship with none.
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
      const fileSetKeys = new Set(manifest.permissionSets.map((permissionSet) => permissionSet.key));
      const fitted = (existing?.permissionSets ?? [])
        .filter((permissionSet) => !fileSetKeys.has(permissionSet.key))
        .map((permissionSet) => fitSetToResources(permissionSet, manifest.resources));
      const merged: Manifest = { ...manifest, permissionSets: [...manifest.permissionSets, ...fitted.map(({ permissionSet }) => permissionSet)] };

      await importManifest(merged, { allowCore: true, session });
      // Importing clears the edited mark, but kept permission sets are still edits that an import shouldn't quietly replace.
      if (fitted.length > 0) await updateModulePermissionRules(manifest.module.key, {}, session);
      synced.push({
        key: manifest.module.key,
        version: manifest.module.version,
        keptPermissionSets: fitted.map(({ permissionSet }) => permissionSet.key),
        droppedPermissions: fitted.flatMap(({ dropped }) => dropped),
      });
    }
    return synced;
  });
}
