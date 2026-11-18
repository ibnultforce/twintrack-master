import { existsSync, readdirSync, readFileSync } from 'node:fs';

export interface SeedFiles {
  manifests: unknown[];
  users: unknown;
  /** The organisation tree. Optional, so a seed can load people without one. */
  orgRoles?: unknown;
  /** Access profiles. The product ships none, so only tests and demos pass these. */
  profiles?: unknown;
  /** Sample HR salaries. Optional, so a seed can load people without them. */
  salaries?: unknown;
}

const readJson = (relativePath: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../../${relativePath}`, import.meta.url), 'utf8'));

const MANIFEST_FILE = /^(.+)\.manifest\.json$/;
const MASTER_KEY = 'master';

/** Every manifests/<key>.manifest.json, Master first, so a module imported in the app and written there is seeded too. */
function listManifestKeys(): string[] {
  const keys = readdirSync(new URL('../../../manifests/', import.meta.url))
    .map((fileName) => MANIFEST_FILE.exec(fileName)?.[1])
    .filter((key): key is string => key !== undefined)
    .sort();
  return [MASTER_KEY, ...keys.filter((key) => key !== MASTER_KEY)];
}

/** A module's manifest, with its data model from `manifests/<key>.schema.json` when that file exists. */
function readManifestWithSchema(key: string): unknown {
  const manifest = readJson(`manifests/${key}.manifest.json`) as Record<string, unknown>;
  const schemaPath = `manifests/${key}.schema.json`;
  return existsSync(new URL(`../../../${schemaPath}`, import.meta.url)) ? { ...manifest, schema: readJson(schemaPath) } : manifest;
}

export const readManifestFiles = (): unknown[] => listManifestKeys().map(readManifestWithSchema);

export function readSeedFiles(): SeedFiles {
  return {
    manifests: readManifestFiles(),
    orgRoles: readJson('seed/org-roles.json'),
    users: readJson('seed/users.json'),
    salaries: readJson('seed/salaries.json'),
  };
}
