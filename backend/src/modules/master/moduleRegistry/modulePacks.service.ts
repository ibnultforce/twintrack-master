import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiError } from '../../../lib/errors.js';
import { findModuleByKey } from './moduleRegistry.repository.js';

/** The handoff packs written by `npm run export:module-pack`, committed in the repo and deployed with it. */
const MODULE_PACKS_FOLDER = fileURLToPath(new URL('../../../../../module-packs/', import.meta.url));

export interface ModulePackFile {
  /** Relative to the pack, with forward slashes, as in `api/manifest.json`. */
  path: string;
  size: number;
}

async function listFilesUnder(folder: string, packRoot: string): Promise<ModulePackFile[]> {
  const entries = await readdir(folder, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const fullPath = join(folder, entry.name);
    if (entry.isDirectory()) return listFilesUnder(fullPath, packRoot);
    if (!entry.isFile()) return [];
    return [{ path: relative(packRoot, fullPath).split(sep).join('/'), size: (await stat(fullPath)).size }];
  }));
  return nested.flat();
}

/** The pack folder of a loaded module, or a 404 for an unknown module or one whose pack hasn't been made. */
async function findPackFolder(key: string): Promise<string> {
  const module = await findModuleByKey(key);
  if (!module) throw new ApiError(404, 'unknown_module', 'No such module.');
  const folder = join(MODULE_PACKS_FOLDER, key);
  if (!existsSync(folder)) throw new ApiError(404, 'no_module_pack', 'This module has no frontend pack yet.');
  return folder;
}

export async function listModulePackFiles(key: string): Promise<ModulePackFile[]> {
  const folder = await findPackFolder(key);
  const files = await listFilesUnder(folder, folder);
  return files.sort((first, second) => first.path.localeCompare(second.path));
}

/** Serves only a path the listing names, so a crafted path can never reach outside the pack. */
export async function readModulePackFile(key: string, path: string): Promise<{ path: string; content: Buffer }> {
  const files = await listModulePackFiles(key);
  const file = files.find((candidate) => candidate.path === path);
  if (!file) throw new ApiError(404, 'unknown_pack_file', 'No such file in this module\'s pack.');
  return { path: file.path, content: await readFile(join(MODULE_PACKS_FOLDER, key, ...file.path.split('/'))) };
}
