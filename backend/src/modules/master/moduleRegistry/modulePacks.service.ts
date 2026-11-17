import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiError } from '../../../lib/errors.js';
import { findModuleByKey } from './moduleRegistry.repository.js';
import { exportModuleManifest } from './moduleRegistry.service.js';
import { describeModuleSchema } from './moduleSchema.service.js';

/**
 * The hand-written parts of each handoff pack (instructions, data model notes, API doc, Postman, design.css), made by
 * `npm run export:module-pack` and committed in the repo.
 */
const MODULE_PACKS_FOLDER = fileURLToPath(new URL('../../../../../module-packs/', import.meta.url));

/** Built from the database on every request, so they always match the module as loaded, with its edits in the app. */
const LIVE_FILE_PATHS = ['api/manifest.json', 'schema.json'] as const;
type LiveFilePath = (typeof LIVE_FILE_PATHS)[number];

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

const isLiveFile = (path: string): path is LiveFilePath => (LIVE_FILE_PATHS as readonly string[]).includes(path);

const toJsonFile = (content: unknown) => Buffer.from(`${JSON.stringify(content, null, 2)}\n`);

async function buildLiveFile(key: string, path: LiveFilePath): Promise<Buffer> {
  if (path === 'api/manifest.json') return toJsonFile(await exportModuleManifest(key));
  const module = await findModuleByKey(key);
  if (!module) throw new ApiError(404, 'unknown_module', 'No such module.');
  return toJsonFile(describeModuleSchema(module));
}

async function assertModuleExists(key: string): Promise<void> {
  if (!(await findModuleByKey(key))) throw new ApiError(404, 'unknown_module', 'No such module.');
}

/** Every loaded module has a pack: its live manifest and schema, plus any committed files for it. */
export async function listModulePackFiles(key: string): Promise<ModulePackFile[]> {
  await assertModuleExists(key);
  const folder = join(MODULE_PACKS_FOLDER, key);
  const committedFiles = existsSync(folder) ? (await listFilesUnder(folder, folder)).filter((file) => !isLiveFile(file.path)) : [];
  const liveFiles = await Promise.all(LIVE_FILE_PATHS.map(async (path) => ({ path, size: (await buildLiveFile(key, path)).length })));
  return [...committedFiles, ...liveFiles].sort((first, second) => first.path.localeCompare(second.path));
}

/** Serves only a path the listing names, so a crafted path can never reach outside the pack. */
export async function readModulePackFile(key: string, path: string): Promise<{ path: string; content: Buffer }> {
  const files = await listModulePackFiles(key);
  const file = files.find((candidate) => candidate.path === path);
  if (!file) throw new ApiError(404, 'unknown_pack_file', 'No such file in this module\'s pack.');
  if (isLiveFile(file.path)) return { path: file.path, content: await buildLiveFile(key, file.path) };
  return { path: file.path, content: await readFile(join(MODULE_PACKS_FOLDER, key, ...file.path.split('/'))) };
}
