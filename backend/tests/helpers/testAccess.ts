import { readFileSync } from 'node:fs';
import { readSeedFiles as readProductSeedFiles, type SeedFiles } from '../../src/seed/seedFiles.js';

interface TestAccess {
  /** The profiles tests add, in the profiles file format. */
  profiles: unknown[];
  /** Person id to the id of the profile they hold. */
  people: Record<string, string>;
}

interface UsersShape {
  users: { id: string; profileId?: string }[];
}

const testAccess = JSON.parse(readFileSync(new URL('../fixtures/test-access.json', import.meta.url), 'utf8')) as TestAccess;

/** The product ships no profiles, so tests add these to the seed files to have people with different access. */
export function readSeedFiles(): SeedFiles {
  const files = readProductSeedFiles();
  for (const user of (files.users as UsersShape).users) {
    const profileId = testAccess.people[user.id];
    if (profileId) user.profileId = profileId;
  }
  files.profiles = { type: 'profiles', profiles: testAccess.profiles };
  return files;
}
