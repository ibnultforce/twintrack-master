import { readFileSync } from 'node:fs';

export interface SeedFiles {
  manifests: unknown[];
  users: unknown;
  /** Sample HR salaries. Optional, so a seed can load people without them. */
  salaries?: unknown;
}

const readJson = (relativePath: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../../${relativePath}`, import.meta.url), 'utf8'));

export const readManifestFiles = (): unknown[] => [
  readJson('manifests/master.manifest.json'),
  readJson('manifests/hr.manifest.json'),
  readJson('manifests/employee.manifest.json'),
];

export function readSeedFiles(): SeedFiles {
  return {
    manifests: readManifestFiles(),
    users: readJson('seed/users.json'),
    salaries: readJson('seed/salaries.json'),
  };
}
