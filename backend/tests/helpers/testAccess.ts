import { readFileSync } from 'node:fs';
import { readSeedFiles as readProductSeedFiles, type SeedFiles } from '../../src/seed/seedFiles.js';

interface TestAccess {
  roles: Record<string, unknown[]>;
  assignments: Record<string, Record<string, string>>;
  privileges: Record<string, Record<string, string[]>>;
}

interface ManifestShape {
  module: { key: string };
  roles: unknown[];
}

interface UsersShape {
  users: { id: string; assignments?: Record<string, string>; privileges?: Record<string, string[]> }[];
}

const testAccess = JSON.parse(readFileSync(new URL('../fixtures/test-access.json', import.meta.url), 'utf8')) as TestAccess;

/** The product ships no roles, so tests add these to the seed files to have people with different access to test against. */
export function readSeedFiles(): SeedFiles {
  const files = readProductSeedFiles();
  for (const manifest of files.manifests as ManifestShape[]) manifest.roles = testAccess.roles[manifest.module.key] ?? [];
  for (const user of (files.users as UsersShape).users) {
    user.assignments = testAccess.assignments[user.id] ?? {};
    const privileges = testAccess.privileges[user.id];
    if (privileges) user.privileges = privileges;
  }
  return files;
}
