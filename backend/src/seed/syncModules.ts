import type { ClientSession } from 'mongoose';
import { prepareCollections, runInTransaction } from '../db.js';
import { ValidationFailure } from '../lib/validation.js';
import { appModels } from '../modules/models.js';
import { recordAudit } from '../modules/master/audit/audit.repository.js';
import { Module } from '../modules/master/models/module.js';
import { validateManifest } from '../modules/master/moduleRegistry/manifest.js';
import { importManifest } from '../modules/master/moduleRegistry/moduleRegistry.service.js';

export interface SyncedModule {
  key: string;
  version: string;
}

export interface SyncResult {
  loaded: SyncedModule[];
  /** Modules whose manifest file is gone, so they were removed. */
  removed: string[];
  /** Modules whose manifest file is gone but that hold custom objects built in the app, so they were kept. */
  keptWithCustomObjects: string[];
}

/**
 * Loads the manifest files into the modules without touching people or profiles. Resources and routes come from the
 * files, and custom objects built in the app are kept. A module that came from a file which is now gone is removed,
 * as `DELETE /modules/:key` would: profiles keep their part for it, which grants nothing.
 */
export async function syncModules(rawManifests: unknown[]): Promise<SyncResult> {
  const manifests = rawManifests.map((raw, index) => {
    const result = validateManifest(raw);
    if (!result.ok) throw new ValidationFailure(`Manifest ${index + 1} is invalid`, result.errors);
    return result.value;
  });
  await prepareCollections(appModels);

  return runInTransaction(async (session) => {
    const loaded: SyncedModule[] = [];
    for (const manifest of manifests) {
      await importManifest(manifest, { allowCore: true, source: 'file', session });
      loaded.push({ key: manifest.module.key, version: manifest.module.version });
    }
    const fileKeys = new Set(loaded.map((module) => module.key));
    return { loaded, ...(await removeModulesWithoutFiles(fileKeys, session)) };
  });
}

/**
 * Modules imported in the app (`source: 'app'`) never had a file, so they stay. Modules saved before `source` existed
 * all came from the seed, so they count as files.
 */
async function removeModulesWithoutFiles(fileKeys: Set<string>, session: ClientSession) {
  const candidates = await Module.find({ key: { $nin: [...fileKeys] }, core: { $ne: true }, source: { $ne: 'app' } }, null, { session }).lean();
  const removed: string[] = [];
  const keptWithCustomObjects: string[] = [];
  for (const module of candidates) {
    if (module.resources.some((resource) => resource.custom === true)) {
      keptWithCustomObjects.push(module.key);
      continue;
    }
    await Module.deleteOne({ key: module.key }, { session });
    await recordAudit(
      {
        action: 'module.removed',
        actorName: 'Manifest reload',
        targetType: 'module',
        targetId: module.key,
        targetName: module.name,
        module: module.key,
        before: { version: module.version },
      },
      session,
    );
    removed.push(module.key);
  }
  return { removed, keptWithCustomObjects };
}
