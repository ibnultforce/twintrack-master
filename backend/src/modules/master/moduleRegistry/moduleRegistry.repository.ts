import type { ClientSession } from 'mongoose';
import { Module } from '../models/module.js';
import type { Manifest } from './manifest.js';

export function findModuleByKey(key: string, session?: ClientSession) {
  return Module.findOne({ key }).session(session ?? null).lean();
}

export function findAllModules() {
  return Module.find().sort({ key: 1 }).lean();
}

/** Creates or replaces a module from its manifest. Returns true if it was created. */
export async function saveModule(manifest: Manifest, isCore: boolean, session?: ClientSession): Promise<boolean> {
  const { resources, routes, roles } = manifest;
  const result = await Module.updateOne(
    { key: manifest.module.key },
    { $set: { ...manifest.module, core: isCore, resources, routes, roles } },
    { upsert: true, session },
  );
  return result.upsertedCount > 0;
}
