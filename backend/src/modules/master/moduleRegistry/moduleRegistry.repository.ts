import type { ClientSession } from 'mongoose';
import { Module, type ModuleDoc, type ModuleSource } from '../models/module.js';
import type { DataModel, Manifest } from './manifest.js';
import type { RouteAccessChange } from './routeAccess.js';

export function findModuleByKey(key: string, session?: ClientSession) {
  return Module.findOne({ key }).session(session ?? null).lean();
}

export function findAllModules() {
  return Module.find().sort({ key: 1 }).lean();
}

/** Saves an edit to a module's resources, and marks the module as edited. */
export async function updateModulePermissionRules(
  key: string,
  rules: Pick<ModuleDoc, 'resources'>,
  session: ClientSession,
): Promise<void> {
  await Module.updateOne({ key }, { $set: { ...rules, permissionsEditedAt: new Date() } }, { session });
}

export async function deleteModule(key: string, session: ClientSession): Promise<void> {
  await Module.deleteOne({ key }, { session });
}

/** Creates or replaces a module from its manifest. Returns true if it was created. */
export async function saveModule(manifest: Manifest, isCore: boolean, source: ModuleSource, session?: ClientSession): Promise<boolean> {
  const { resources, routes, schema } = manifest;
  // permissionSets is unset because modules saved before permission sets were removed still hold them.
  // A manifest without a schema keeps the one the module has.
  const result = await Module.updateOne(
    { key: manifest.module.key },
    { $set: { ...manifest.module, core: isCore, source, resources, routes, ...(schema && { schema }) }, $unset: { permissionsEditedAt: 1, permissionSets: 1 } },
    // strict: false lets the $unset reach permissionSets, which is no longer in the schema. The $set is a validated manifest.
    { upsert: true, session, strict: false },
  );
  return result.upsertedCount > 0;
}

export async function saveModuleSchema(key: string, schema: DataModel, session: ClientSession): Promise<void> {
  await Module.updateOne({ key }, { $set: { schema } }, { session });
}

/** Saves the access rules a super admin changed. Doesn't mark resources as edited, since resources are unchanged. */
export async function saveRouteAccessChanges(key: string, routeAccess: RouteAccessChange[], session: ClientSession): Promise<void> {
  await Module.updateOne({ key }, { $set: { routeAccess } }, { session });
}
