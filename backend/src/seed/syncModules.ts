import { prepareCollections, runInTransaction } from '../db.js';
import { ValidationFailure } from '../lib/validation.js';
import { appModels } from '../modules/models.js';
import { validateManifest } from '../modules/master/moduleRegistry/manifest.js';
import { importManifest } from '../modules/master/moduleRegistry/moduleRegistry.service.js';

export interface SyncedModule {
  key: string;
  version: string;
}

/**
 * Loads the manifest files into the modules without touching people or profiles. Resources and routes come from the
 * files, and custom objects built in the app are kept.
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
      await importManifest(manifest, { allowCore: true, session });
      synced.push({ key: manifest.module.key, version: manifest.module.version });
    }
    return synced;
  });
}
