import type { ClientSession } from 'mongoose';
import { Module } from '../models/module.js';
import { User } from '../models/user.js';
import type { Manifest } from './manifest.js';

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
  const { key, core = false } = manifest.module;

  if (!allowCore) {
    const existing = await Module.findOne({ key }).session(session ?? null).lean();
    if (core || existing?.core) throw new CoreModuleError(`Module "${key}" is a core module and can't be imported.`);
  }

  const result = await Module.updateOne(
    { key },
    { $set: { ...manifest.module, core, resources: manifest.resources, routes: manifest.routes, roles: manifest.roles } },
    { upsert: true, session },
  );

  const orphanedAssignments = await User.countDocuments({
    [`assignments.${key}`]: { $exists: true, $nin: manifest.roles.map((role) => role.key) },
  }).session(session ?? null);

  return { key, version: manifest.module.version, created: result.upsertedCount > 0, orphanedAssignments };
}
