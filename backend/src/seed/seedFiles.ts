import { readFileSync } from 'node:fs';

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

export const readManifestFiles = (): unknown[] => [
  readJson('manifests/master.manifest.json'),
  readJson('manifests/hr.manifest.json'),
  readJson('manifests/tasks.manifest.json'),
];

export function readSeedFiles(): SeedFiles {
  return {
    manifests: readManifestFiles(),
    orgRoles: readJson('seed/org-roles.json'),
    users: readJson('seed/users.json'),
    salaries: readJson('seed/salaries.json'),
  };
}
