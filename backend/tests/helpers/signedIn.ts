import { hash } from '@node-rs/argon2';
import type { Application } from 'express';
import request from 'supertest';
import { AccessProfile } from '../../src/modules/master/models/accessProfile.js';
import { OrgRole } from '../../src/modules/master/models/orgRole.js';
import { User } from '../../src/modules/master/models/user.js';
import { validateManifest } from '../../src/modules/master/moduleRegistry/manifest.js';
import { importManifest } from '../../src/modules/master/moduleRegistry/moduleRegistry.service.js';
import { readSeedFiles } from './testAccess.js';
import { TEST_ORIGIN } from './testConfig.js';

export const TEST_PASSWORD = 'correct-password';

const passwordHashPromise = hash(TEST_PASSWORD);

interface ProfileRow {
  id: string;
  name: string;
  description?: string;
  grants: Record<string, unknown>;
}

/**
 * Loads the same modules as the seed, and the test profiles from fixtures/test-access.json, so a person added with
 * addPerson can hold one through profileId. Master has to be loaded for any private route to answer.
 */
export async function importSeedManifests(): Promise<void> {
  const files = readSeedFiles();
  for (const raw of files.manifests) {
    const manifest = validateManifest(raw);
    if (!manifest.ok) throw new Error(JSON.stringify(manifest.errors));
    await importManifest(manifest.value, { allowCore: true });
  }
  const { profiles } = files.profiles as { profiles: ProfileRow[] };
  await AccessProfile.insertMany(profiles.map(({ id, ...profile }) => ({ _id: id, ...profile })));
}

export async function addPerson(id: string, overrides: Record<string, unknown> = {}) {
  return User.create({
    _id: id,
    name: `Person ${id}`,
    email: `${id}@twintrack.test`,
    passwordHash: await passwordHashPromise,
    ...overrides,
  });
}

/** Adds a role to the org tree. With no parent it becomes the root. */
export async function addOrgRole(id: string, parentId?: string) {
  const parent = parentId ? await OrgRole.findById(parentId).lean() : null;
  if (parentId && !parent) throw new Error(`Org role ${parentId} must be added before ${id}.`);
  return OrgRole.create({
    _id: id,
    name: `Org role ${id}`,
    ...(parent ? { parentId, ancestorIds: [...parent.ancestorIds, parent._id] } : { ancestorIds: [], isRoot: true }),
  });
}

export async function signIn(app: Application, email: string, password = TEST_PASSWORD): Promise<string> {
  const response = await request(app).post('/auth/login').set('Origin', TEST_ORIGIN).send({ email, password });
  if (response.status !== 200) throw new Error(`Sign-in for ${email} answered ${response.status}.`);
  return (response.body as { accessToken: string }).accessToken;
}

/** Sends requests as one signed-in person. */
export function requestsAs(app: Application, token: string) {
  const bearer = `Bearer ${token}`;
  return {
    get: (path: string) => request(app).get(path).set('Authorization', bearer),
    post: (path: string, body?: object) => request(app).post(path).set('Authorization', bearer).send(body),
    patch: (path: string, body?: object) => request(app).patch(path).set('Authorization', bearer).send(body),
    put: (path: string, body: object) => request(app).put(path).set('Authorization', bearer).send(body),
    delete: (path: string) => request(app).delete(path).set('Authorization', bearer),
  };
}
