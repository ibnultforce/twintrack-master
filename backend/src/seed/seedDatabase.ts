import { hash } from '@node-rs/argon2';
import { prepareCollections, runInTransaction } from '../db.js';
import { ValidationFailure } from '../lib/validation.js';
import { validateSalariesFile } from '../modules/hr/salary/salariesFile.js';
import { upsertSalaries } from '../modules/hr/salary/salary.repository.js';
import { appModels } from '../modules/models.js';
import { validateManifest, type Manifest } from '../modules/master/moduleRegistry/manifest.js';
import { importManifest, type ImportResult } from '../modules/master/moduleRegistry/moduleRegistry.service.js';
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
  const users = validateUsersFile(options.files.users, manifests);
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

    const { created, updated } = await upsertUsers(users.value, passwordHash, session);
    await upsertSalaries(salaries.value, session);
    return { modules, usersCreated: created, usersUpdated: updated };
  });
}
