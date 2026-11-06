import { readFileSync } from 'node:fs';
import { verify } from '@node-rs/argon2';
import { describe, expect, it } from 'vitest';
import { ValidationFailure } from '../src/lib/validation.js';
import { Module } from '../src/modules/master/models/module.js';
import { User } from '../src/modules/master/models/user.js';
import { validateManifest, type Manifest } from '../src/modules/master/moduleRegistry/manifest.js';
import { validateUsersFile } from '../src/modules/master/users/usersFile.js';
import { seedDatabase } from '../src/seed/seedDatabase.js';
import { readSeedFiles, type SeedFiles } from '../src/seed/seedFiles.js';
import { useTestDatabase } from './helpers/database.js';

const readJson = (path: string): unknown => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const seed = (files: SeedFiles = readSeedFiles(), password = 'demo1234') =>
  seedDatabase({ files, password, nodeEnv: 'test' });

const row = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  name: `Person ${id}`,
  email: `${id}@x.test`,
  ...overrides,
});
const errorsFor = (users: unknown[], modules: Manifest[] = []): string => {
  const result = validateUsersFile({ type: 'users', users }, modules);
  return result.ok ? '' : result.errors.map((e) => `${e.path}: ${e.message}`).join('\n');
};

describe('validateUsersFile', () => {
  const hr = (() => {
    const result = validateManifest(readJson('../../manifests/hr.manifest.json'));
    if (!result.ok) throw new Error('HR manifest is invalid');
    return result.value;
  })();

  it('accepts the example team', () => {
    const result = validateUsersFile(readSeedFiles().users, [hr]);
    expect(result.ok && result.value.length).toBe(10);
  });

  it('reports every problem in the invalid sample at once', () => {
    const result = validateUsersFile(readJson('./fixtures/users-invalid.json'), []);
    expect(result.ok).toBe(false);
    const text = result.ok ? '' : result.errors.map((e) => `${e.path}: ${e.message}`).join('\n');
    expect(text).toMatch(/users\.0\.contract/);
    expect(text).toMatch(/users\.1\.status/);
    expect(text).toMatch(/manager "u_999" is not in this file/);
    expect(text).toMatch(/cannot be their own manager/);
    expect(text).toMatch(/email "b1@twintrack\.test" is used twice/);
    expect(text).toMatch(/id "b1" is used twice/);
    expect(text).toMatch(/users\.6\.email/);
    expect(text).toMatch(/users\.7\.name/);
    expect(text).toMatch(/users\.8\.assignments/);
  });

  it('rejects a reporting line that goes round in a circle', () => {
    const text = errorsFor([row('a', { managerId: 'b' }), row('b', { managerId: 'a' })]);
    expect(text).toMatch(/goes round in a circle/);
  });

  it('checks roles and privileges only against registered modules', () => {
    expect(errorsFor([row('a', { assignments: { hr: 'nope' } })], [hr])).toMatch(/"nope" is not a role in hr/);
    expect(errorsFor([row('a', { privileges: { hr: ['employee.delete'] } })], [hr])).toMatch(/can't be granted/);
    expect(errorsFor([row('a', { privileges: { hr: ['salary.read'] } })], [hr])).toBe('');
    expect(errorsFor([row('a', { assignments: { account: 'viewer' } })], [hr])).toBe('');
  });

  it('rejects a file of the wrong type', () => {
    expect(validateUsersFile({ type: 'other' }, []).ok).toBe(false);
    expect(validateUsersFile(null, []).ok).toBe(false);
  });
});

describe('seedDatabase', () => {
  useTestDatabase();

  it('loads Master, HR and the 10-person team', async () => {
    const result = await seed();
    expect(result.modules.map((module) => module.key)).toEqual(['master', 'hr']);
    expect(result.usersCreated).toBe(10);

    expect((await Module.findOne({ key: 'master' }).lean())?.core).toBe(true);
    expect((await Module.findOne({ key: 'hr' }).lean())?.core).toBe(false);

    const rahim = await User.findById('u_04').lean();
    expect(rahim).toMatchObject({ name: 'Rahim Uddin', managerId: 'u_01', assignments: { hr: 'manager' } });
    expect((await User.findById('u_03').lean())?.assignments.master).toBe('hr-access');
    expect((await User.findById('u_01').lean())?.superAdmin).toBe(true);
    expect((await User.findById('u_11').lean())?.status).toBe('inactive');
    expect((await User.findById('u_08').lean())?.assignments).toEqual({});
  });

  it('can be re-run without duplicating anything', async () => {
    await seed();
    const again = await seed();
    expect(again.usersCreated).toBe(0);
    expect(again.modules.every((module) => !module.created)).toBe(true);
    expect(await User.countDocuments()).toBe(10);
    expect(await Module.countDocuments()).toBe(2);
  });

  it('resets access on re-run but keeps passwords already set', async () => {
    await seed();
    const original = await User.findById('u_08').select('+passwordHash').lean();
    await User.updateOne({ _id: 'u_08' }, { $set: { 'assignments.hr': 'admin' } });

    await seed(readSeedFiles(), 'a-different-password');

    const after = await User.findById('u_08').select('+passwordHash').lean();
    expect(after?.assignments).toEqual({});
    expect(after?.passwordHash).toBe(original?.passwordHash);
  });

  it('stores passwords hashed with Argon2id, never in plain text', async () => {
    await seed();
    const { passwordHash } = (await User.findById('u_04').select('+passwordHash').lean())!;
    expect(passwordHash).toMatch(/^\$argon2id\$/);
    expect(await verify(passwordHash, 'demo1234')).toBe(true);
    expect((await User.findById('u_04').lean())?.passwordHash).toBeUndefined();
  });

  it('writes nothing when any file is invalid', async () => {
    const badUsers = clone(readSeedFiles());
    (badUsers.users as { users: { assignments: object }[] }).users[1]!.assignments = { hr: 'not-a-role' };
    await expect(seed(badUsers)).rejects.toThrow(ValidationFailure);

    const badManifest = clone(readSeedFiles());
    (badManifest.manifests[1] as { module: { version: string } }).module.version = 'v2';
    await expect(seed(badManifest)).rejects.toThrow(ValidationFailure);

    expect(await Module.countDocuments()).toBe(0);
    expect(await User.countDocuments()).toBe(0);
  });

  it('rolls everything back when a write fails partway', async () => {
    await User.create({ _id: 'other', name: 'Other', email: 'rahim@twintrack.test', passwordHash: 'x' });
    await expect(seed()).rejects.toThrow();
    expect(await Module.countDocuments()).toBe(0);
    expect(await User.countDocuments()).toBe(1);
  });

  it('refuses to run in production', async () => {
    await expect(
      seedDatabase({ files: readSeedFiles(), password: 'demo1234', nodeEnv: 'production' }),
    ).rejects.toThrow(/production/);
    expect(await User.countDocuments()).toBe(0);
  });
});
