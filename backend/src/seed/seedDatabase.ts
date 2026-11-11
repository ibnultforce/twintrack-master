import { hash } from '@node-rs/argon2';
import { prepareCollections, runInTransaction } from '../db.js';
import { ValidationFailure } from '../lib/validation.js';
import { validateSalariesFile } from '../modules/hr/salary/salariesFile.js';
import { upsertSalaries } from '../modules/hr/salary/salary.repository.js';
import { appModels } from '../modules/models.js';
import { validateManifest, type Manifest } from '../modules/master/moduleRegistry/manifest.js';
import { importManifest, type ImportResult } from '../modules/master/moduleRegistry/moduleRegistry.service.js';
import { upsertProfiles } from '../modules/master/accessProfiles/accessProfiles.repository.js';
import { validateProfilesFile } from '../modules/master/accessProfiles/accessProfilesFile.js';
import { validateOrgRolesFile } from '../modules/master/orgRoles/orgRolesFile.js';
import { upsertOrgRoles } from '../modules/master/orgRoles/orgRoles.repository.js';
import { upsertUsers } from '../modules/master/users/users.repository.js';
import { validateUsersFile } from '../modules/master/users/usersFile.js';
import type { SeedFiles } from './seedFiles.js';

export interface SeedResult {
  modules: ImportResult[];
  usersCreated: number;
  usersUpdated: number;
}

function readValidManifests(rawManifests: unknown[]): Manifest[] {
  return rawManifests.map((raw, index) => {
    const result = validateManifest(raw);
    if (!result.ok) throw new ValidationFailure(`Seed manifest ${index + 1} is invalid`, result.errors);
    return result.value;
  });
}

/**
 * Loads the example modules and team. Safe to re-run: it updates records by id, resets access to what the
 * files say, and keeps passwords people have already set. Files are checked first and writes are all-or-nothing.
 */
export async function seedDatabase(options: {
  files: SeedFiles;
  password: string;
  nodeEnv: string;
}): Promise<SeedResult> {
  if (options.nodeEnv === 'production') {
    throw new Error('The seed uses a shared demo password, so it refuses to run in production.');
  }

  const manifests = readValidManifests(options.files.manifests);
  const orgRoles = options.files.orgRoles === undefined ? { ok: true as const, value: [] } : validateOrgRolesFile(options.files.orgRoles);
  if (!orgRoles.ok) throw new ValidationFailure('Seed org roles file is invalid', orgRoles.errors);
  const orgRoleIds = options.files.orgRoles === undefined ? undefined : new Set(orgRoles.value.map((orgRole) => orgRole._id));
  const profiles = options.files.profiles === undefined ? { ok: true as const, value: [] } : validateProfilesFile(options.files.profiles, manifests);
  if (!profiles.ok) throw new ValidationFailure('Seed profiles file is invalid', profiles.errors);
  const profileIds = new Set(profiles.value.map((profile) => profile._id));
  const users = validateUsersFile(options.files.users, { orgRoleIds, profileIds });
  if (!users.ok) throw new ValidationFailure('Seed users file is invalid', users.errors);
  const salaries = options.files.salaries === undefined
    ? { ok: true as const, value: [] }
    : validateSalariesFile(options.files.salaries, new Set(users.value.map((user) => user.id)));
  if (!salaries.ok) throw new ValidationFailure('Seed salaries file is invalid', salaries.errors);

  const passwordHash = await hash(options.password);
  await prepareCollections(appModels);

  return runInTransaction(async (session) => {
    const modules: ImportResult[] = [];
    for (const manifest of manifests) modules.push(await importManifest(manifest, { allowCore: true, session }));

    await upsertOrgRoles(orgRoles.value, session);
    await upsertProfiles(profiles.value, session);
    const { created, updated } = await upsertUsers(users.value, passwordHash, session);
    await upsertSalaries(salaries.value, session);
    return { modules, usersCreated: created, usersUpdated: updated };
  });
}
