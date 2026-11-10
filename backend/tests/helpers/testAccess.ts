import { readFileSync } from 'node:fs';
import { readSeedFiles as readProductSeedFiles, type SeedFiles } from '../../src/seed/seedFiles.js';

interface TestAccess {
  /** Module key to the permission sets tests add to that module. */
  permissionSets: Record<string, unknown[]>;
  /** Person id to the permission sets they hold, by module. */
  people: Record<string, Record<string, string[]>>;
  profiles: unknown[];
}

interface ManifestShape {
  module: { key: string };
  permissionSets: unknown[];
}

interface UsersShape {
  users: { id: string; permissionSets?: Record<string, string[]> }[];
}

const testAccess = JSON.parse(readFileSync(new URL('../fixtures/test-access.json', import.meta.url), 'utf8')) as TestAccess;

/** The product ships no profiles or permission sets, so tests add these to the seed files to have people with different access. */
export function readSeedFiles(): SeedFiles {
  const files = readProductSeedFiles();
  for (const manifest of files.manifests as ManifestShape[]) manifest.permissionSets = testAccess.permissionSets[manifest.module.key] ?? [];
  for (const user of (files.users as UsersShape).users) user.permissionSets = testAccess.people[user.id] ?? {};
  files.profiles = { type: 'profiles', profiles: testAccess.profiles };
  return files;
}
