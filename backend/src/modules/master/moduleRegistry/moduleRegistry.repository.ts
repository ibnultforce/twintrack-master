import type { ClientSession } from 'mongoose';
import { Module, type ModuleDoc } from '../models/module.js';
import type { Manifest } from './manifest.js';

export function findModuleByKey(key: string, session?: ClientSession) {
  return Module.findOne({ key }).session(session ?? null).lean();
}

export function findAllModules() {
  return Module.find().sort({ key: 1 }).lean();
}

/** Saves a super admin's edit to a module's roles or resources, and marks the module as edited. */
export async function updateModulePermissionRules(
  key: string,
  rules: Partial<Pick<ModuleDoc, 'roles' | 'resources'>>,
  session: ClientSession,
): Promise<void> {
  await Module.updateOne({ key }, { $set: { ...rules, permissionsEditedAt: new Date() } }, { session });
}

export async function deleteModule(key: string, session: ClientSession): Promise<void> {
  await Module.deleteOne({ key }, { session });
}

/** Creates or replaces a module from its manifest. Returns true if it was created. */
export async function saveModule(manifest: Manifest, isCore: boolean, session?: ClientSession): Promise<boolean> {
  const { resources, routes, roles } = manifest;
  const result = await Module.updateOne(
    { key: manifest.module.key },
    { $set: { ...manifest.module, core: isCore, resources, routes, roles }, $unset: { permissionsEditedAt: 1 } },
    { upsert: true, session },
  );
  return result.upsertedCount > 0;
}
