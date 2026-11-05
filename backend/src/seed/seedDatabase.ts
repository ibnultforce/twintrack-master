import { readFileSync } from 'node:fs';
import { hash } from '@node-rs/argon2';
import mongoose from 'mongoose';
import { ValidationFailure } from '../lib/validation.js';
import { AuditLog } from '../models/auditLog.js';
import { Module } from '../models/module.js';
import { Session } from '../models/session.js';
import { User } from '../models/user.js';
import { importManifest, type ImportResult } from '../modules/importManifest.js';
import { validateManifest, type Manifest } from '../modules/manifest.js';
import { validateUsersFile } from '../users/usersFile.js';

export interface SeedFiles {
  manifests: unknown[];
  users: unknown;
}

export interface SeedResult {
  modules: ImportResult[];
  usersCreated: number;
  usersUpdated: number;
}

const readJson = (relativePath: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../../${relativePath}`, import.meta.url), 'utf8'));

export function readSeedFiles(): SeedFiles {
  return {
    manifests: [readJson('access.manifest.json'), readJson('seed/manifests/hr.json')],
    users: readJson('seed/users.json'),
  };
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

  const manifests: Manifest[] = options.files.manifests.map((raw, index) => {
    const result = validateManifest(raw);
    if (!result.ok) throw new ValidationFailure(`Seed manifest ${index + 1} is invalid`, result.errors);
    return result.value;
  });

  const users = validateUsersFile(options.files.users, manifests);
  if (!users.ok) throw new ValidationFailure('Seed users file is invalid', users.errors);

  const passwordHash = await hash(options.password);

  // Collections and indexes can't be created safely inside the transaction.
  await Promise.all([User.init(), Module.init(), Session.init(), AuditLog.init()]);

  return mongoose.connection.transaction(async (session) => {
    const modules: ImportResult[] = [];
    for (const manifest of manifests) modules.push(await importManifest(manifest, { allowCore: true, session }));

    const written = await User.bulkWrite(
      users.value.map(({ id, ...row }) => ({
        updateOne: {
          filter: { _id: id },
          update: { $set: row, $setOnInsert: { passwordHash, mustChangePassword: false } },
          upsert: true,
        },
      })),
      { session },
    );

    return { modules, usersCreated: written.upsertedCount, usersUpdated: written.modifiedCount };
  });
}
