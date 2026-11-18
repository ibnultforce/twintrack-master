import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';
import pino from 'pino';
import { isApiRegistered } from '../../../lib/apiRoute.js';
import type { DataModel, Manifest } from './manifest.js';

const runFile = promisify(execFile);

/** The twintrack-master repo, which holds manifests/, module-packs/ and scripts/. */
export const MASTER_REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const PACK_SCRIPT = 'scripts/exportModulePack.mjs';
const PACK_TIMEOUT_MS = 60_000;

const NOT_SYNCED_WARNING =
  'This server does not write repo files, so the change is in the database only. The next deploy or `npm run seed:modules` loads manifests/ again and replaces it: make the same change in the twintrack-master repo.';

type FileChanges = Pick<ModuleFilesReport, 'written' | 'removed' | 'unchanged'>;

/** What an import or removal did to the repo's files, returned to the caller so nobody assumes more happened. */
export interface ModuleFilesReport {
  /** False when this server doesn't write repo files, or writing them failed. */
  synced: boolean;
  /** Repo paths written or deleted, with forward slashes. */
  written: string[];
  removed: string[];
  /** Files that already held the same content, so they were left as they were. */
  unchanged: string[];
  /** Whether module-packs/<key>/ was rebuilt by `npm run export:module-pack`, and why not if it wasn't. */
  pack: { rebuilt: boolean; message?: string };
  /** Routes the manifest lists, not marked planned, that the backend doesn't serve yet: they need backend code. */
  routesWithoutCode: string[];
  warning?: string;
}

/** Keeps the repo's copy of a module in step with the database. Tests pass one that writes to a temporary folder. */
export interface ModuleFiles {
  readonly isEnabled: boolean;
  /** After a manifest import. The schema file is written only when the import carried a schema. */
  saveManifest(manifest: Manifest): Promise<ModuleFilesReport>;
  /** After a schema import. */
  saveSchema(key: string, schema: DataModel): Promise<ModuleFilesReport>;
  /** After a module is removed, with its change file. The pack folder stays: it holds hand-written files. */
  removeModule(key: string): Promise<ModuleFilesReport>;
  /** Writes manifests/changes/<key>.md, or deletes it when `markdown` is null because nothing is pending. */
  saveChangeLog(key: string, markdown: string | null): Promise<ChangeLogReport | null>;
}

/** What happened to a module's list of changes still to build. */
export interface ChangeLogReport {
  path: string;
  outcome: 'written' | 'removed' | 'unchanged' | 'failed';
}

export const changeLogPath = (key: string) => `manifests/changes/${key}.md`;

const joinPath = (baseUrl: string, path: string) => `${baseUrl.replace(/\/$/, '')}${path === '/' ? '' : path}` || '/';

/** The APIs a manifest promises that no registered route serves, as "METHOD /full/path". */
export function findRoutesWithoutCode(manifest: Pick<Manifest, 'module' | 'routes'>): string[] {
  const baseUrl = manifest.module.baseUrl ?? `/${manifest.module.key}`;
  return manifest.routes
    .filter((route) => !route.planned)
    .map((route) => `${route.method} ${joinPath(baseUrl, route.path)}`)
    .filter((api) => !isApiRegistered(api));
}

const manifestPath = (key: string) => `manifests/${key}.manifest.json`;
const schemaPath = (key: string) => `manifests/${key}.schema.json`;

/** The manifest as its repo file holds it: the schema has its own file, and custom objects live only in the database. */
function toManifestFile({ schema: _schema, ...manifest }: Manifest): Record<string, unknown> {
  return { ...manifest, resources: manifest.resources.filter((resource) => resource.custom !== true) };
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The new content with its keys in the order the existing file has them, new keys last, so a changed file's diff
 * shows only what changed. Arrays keep the new order, because their order means something.
 */
function inExistingKeyOrder(content: unknown, existing: unknown): unknown {
  if (Array.isArray(content)) {
    return content.map((item, index) => inExistingKeyOrder(item, Array.isArray(existing) ? existing[index] : undefined));
  }
  if (!isPlainObject(content)) return content;
  const existingObject = isPlainObject(existing) ? existing : {};
  const existingKeys = Object.keys(existingObject).filter((key) => key in content);
  const orderedKeys = [...existingKeys, ...Object.keys(content).filter((key) => !existingKeys.includes(key))];
  return Object.fromEntries(orderedKeys.map((key) => [key, inExistingKeyOrder(content[key], existingObject[key])]));
}

const LF = '\n';
const CRLF = '\r\n';
const toJsonText = (content: unknown, lineEnding: string) => `${JSON.stringify(content, null, 2)}${LF}`.replaceAll(LF, lineEnding);

interface ExistingFile {
  /** Undefined when the file isn't valid JSON, so it is replaced. */
  content: unknown;
  lineEnding: string;
}

async function readExistingFile(fullPath: string): Promise<ExistingFile | null> {
  if (!existsSync(fullPath)) return null;
  const text = await readFile(fullPath, 'utf8');
  const lineEnding = text.includes(CRLF) ? CRLF : LF;
  try {
    return { content: JSON.parse(text), lineEnding };
  } catch {
    // A broken file is replaced: the import has just checked what goes in its place.
    return { content: undefined, lineEnding };
  }
}

export function createDisabledModuleFiles(): ModuleFiles {
  const report = (routesWithoutCode: string[]): ModuleFilesReport => ({
    synced: false,
    written: [],
    removed: [],
    unchanged: [],
    pack: { rebuilt: false, message: 'This server does not write repo files.' },
    routesWithoutCode,
    warning: NOT_SYNCED_WARNING,
  });
  return {
    isEnabled: false,
    saveManifest: async (manifest) => report(findRoutesWithoutCode(manifest)),
    saveSchema: async () => report([]),
    removeModule: async () => report([]),
    saveChangeLog: async () => null,
  };
}

/** Writes into `repoRoot`. A failure is reported, never thrown: the database change has already been saved. */
export function createModuleFiles(repoRoot: string, logLevel = 'info'): ModuleFiles {
  const logger = pino({ level: logLevel });

  /**
   * Leaves a file that already holds this content alone, keeping its hand formatting. Otherwise keeps its key order
   * and line endings, writes beside it and renames, so a crash never leaves half a JSON file for the seed to choke on.
   */
  async function writeRepoFile(relativePath: string, content: unknown): Promise<'written' | 'unchanged'> {
    const fullPath = join(repoRoot, relativePath);
    const existing = await readExistingFile(fullPath);
    if (existing && isDeepStrictEqual(existing.content, content)) return 'unchanged';
    await mkdir(join(fullPath, '..'), { recursive: true });
    const temporaryPath = `${fullPath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, toJsonText(inExistingKeyOrder(content, existing?.content), existing?.lineEnding ?? LF), 'utf8');
    await rename(temporaryPath, fullPath);
    return 'written';
  }

  async function writeRepoFiles(files: [relativePath: string, content: unknown][]): Promise<FileChanges> {
    const changes: FileChanges = { written: [], removed: [], unchanged: [] };
    for (const [relativePath, content] of files) changes[await writeRepoFile(relativePath, content)].push(relativePath);
    return changes;
  }

  async function removeRepoFiles(relativePaths: string[]): Promise<FileChanges> {
    const changes: FileChanges = { written: [], removed: [], unchanged: [] };
    for (const relativePath of relativePaths) {
      const fullPath = join(repoRoot, relativePath);
      if (!existsSync(fullPath)) continue;
      await rm(fullPath);
      changes.removed.push(relativePath);
    }
    return changes;
  }

  /** Runs the same script as `npm run export:module-pack`, so the pack is built one way only. */
  async function rebuildPack(key: string): Promise<ModuleFilesReport['pack']> {
    if (!existsSync(join(repoRoot, PACK_SCRIPT))) return { rebuilt: false, message: `${PACK_SCRIPT} is not in this repo.` };
    try {
      await runFile(process.execPath, [PACK_SCRIPT, key], { cwd: repoRoot, timeout: PACK_TIMEOUT_MS });
      return { rebuilt: true };
    } catch (error) {
      // The script explains itself on its first line, such as a missing docs/api/<key>.md for a new module.
      const firstLine = String((error as { stderr?: string }).stderr ?? '').trim().split('\n')[0];
      return { rebuilt: false, message: firstLine || (error as Error).message };
    }
  }

  async function sync(
    key: string,
    change: () => Promise<FileChanges>,
    options: { routesWithoutCode: string[]; rebuildsPack: boolean },
  ): Promise<ModuleFilesReport> {
    try {
      const changes = await change();
      const pack = options.rebuildsPack ? await rebuildPack(key) : { rebuilt: false, message: 'The pack folder is kept: it holds hand-written files.' };
      return { synced: true, ...changes, pack, routesWithoutCode: options.routesWithoutCode };
    } catch (error) {
      logger.error({ module: key, reason: (error as Error).message }, 'Could not write the module files');
      return {
        synced: false,
        written: [],
        removed: [],
        unchanged: [],
        pack: { rebuilt: false },
        routesWithoutCode: options.routesWithoutCode,
        warning: `The change is saved in the database, but the repo files could not be written (${(error as NodeJS.ErrnoException).code ?? 'error'}). ${NOT_SYNCED_WARNING}`,
      };
    }
  }

  return {
    isEnabled: true,
    saveManifest: (manifest) => {
      const { key } = manifest.module;
      const files: [string, unknown][] = [[manifestPath(key), toManifestFile(manifest)]];
      if (manifest.schema) files.push([schemaPath(key), manifest.schema]);
      return sync(key, () => writeRepoFiles(files), { routesWithoutCode: findRoutesWithoutCode(manifest), rebuildsPack: true });
    },
    saveSchema: (key, schema) => sync(key, () => writeRepoFiles([[schemaPath(key), schema]]), { routesWithoutCode: [], rebuildsPack: true }),
    removeModule: (key) => sync(key, () => removeRepoFiles([manifestPath(key), schemaPath(key), changeLogPath(key)]), { routesWithoutCode: [], rebuildsPack: false }),
    saveChangeLog: async (key, markdown) => {
      const path = changeLogPath(key);
      const fullPath = join(repoRoot, path);
      try {
        if (markdown === null) {
          if (!existsSync(fullPath)) return { path, outcome: 'unchanged' };
          await rm(fullPath);
          return { path, outcome: 'removed' };
        }
        if (existsSync(fullPath) && (await readFile(fullPath, 'utf8')) === markdown) return { path, outcome: 'unchanged' };
        await mkdir(join(fullPath, '..'), { recursive: true });
        await writeFile(fullPath, markdown, 'utf8');
        return { path, outcome: 'written' };
      } catch (error) {
        // The changes are saved in the database and shown on the Modules screen, so a failed file write isn't fatal.
        logger.error({ module: key, reason: (error as Error).message }, 'Could not write the module change log');
        return { path, outcome: 'failed' };
      }
    },
  };
}
