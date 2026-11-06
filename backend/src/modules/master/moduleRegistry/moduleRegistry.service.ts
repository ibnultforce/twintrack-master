import type { ClientSession } from 'mongoose';
import { countUsersWithRoleOutside } from '../users/users.repository.js';
import type { Manifest } from './manifest.js';
import { findModuleByKey, saveModule } from './moduleRegistry.repository.js';

export class CoreModuleError extends Error {}

export interface ImportResult {
  key: string;
  version: string;
  created: boolean;
  /** People whose role no longer exists in this module. They keep no access from it until reassigned. */
  orphanedAssignments: number;
}

/** Saves a validated manifest. Only the seed may set up core modules, so the API can't replace Master's own rules. */
export async function importManifest(
  manifest: Manifest,
  options: { allowCore?: boolean; session?: ClientSession } = {},
): Promise<ImportResult> {
  const { allowCore = false, session } = options;
  const { key, version, core: isCore = false } = manifest.module;

  if (!allowCore) {
    const existingModule = await findModuleByKey(key, session);
    if (isCore || existingModule?.core) throw new CoreModuleError(`Module "${key}" is a core module and can't be imported.`);
  }

  const created = await saveModule(manifest, isCore, session);
  const roleKeys = manifest.roles.map((role) => role.key);
  const orphanedAssignments = await countUsersWithRoleOutside(key, roleKeys, session);

  return { key, version, created, orphanedAssignments };
}
