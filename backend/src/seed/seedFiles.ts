import { readFileSync } from 'node:fs';

export interface SeedFiles {
  manifests: unknown[];
  users: unknown;
}

const readJson = (relativePath: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../../${relativePath}`, import.meta.url), 'utf8'));

export function readSeedFiles(): SeedFiles {
  return {
    manifests: [readJson('manifests/master.manifest.json'), readJson('manifests/hr.manifest.json')],
    users: readJson('seed/users.json'),
  };
}
