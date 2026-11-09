import { readFileSync } from 'node:fs';
import type { Application } from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { employeeRoutes } from '../src/modules/employee/employee.routes.js';
import { seedDatabase } from '../src/seed/seedDatabase.js';
import { readSeedFiles } from './helpers/testAccess.js';
import { useTestDatabase } from './helpers/database.js';
import { requestsAs, signIn } from './helpers/signedIn.js';
import { createTestConfig } from './helpers/testConfig.js';

const PASSWORD = 'correct-password';
const PROFILE_PATH = '/employee/me/profile';
const ID = { RAHIM: 'u_04', JASMIN: 'u_12', JACK: 'u_13' };

describe('Employee module', () => {
  useTestDatabase();

  let app: Application;
  const as = async (name: string) => requestsAs(app, await signIn(app, `${name}@twintrack.test`, PASSWORD));
  const setJackPrivileges = async (permissions: string[]) =>
    (await as('jasmin')).put(`/users/${ID.JACK}/privileges`, { module: 'employee', permissions, reason: 'Keeps his own details current' });

  beforeAll(() => {
    app = createApp(createTestConfig());
  });

  beforeEach(async () => {
    await seedDatabase({ files: readSeedFiles(), password: PASSWORD, nodeEnv: 'test' });
  });

  it('builds what the Employee manifest says is built, with the same permissions', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../manifests/employee.manifest.json', import.meta.url), 'utf8')) as {
      module: { baseUrl: string };
      routes: { method: string; path: string; permission?: string; planned?: boolean }[];
    };
    const describeRoute = (route: { method: string; path: string; permission?: string }) => `${route.method} ${route.path} ${route.permission}`;
    const built = manifest.routes.filter((route) => !route.planned).map((route) => describeRoute({ ...route, path: `${manifest.module.baseUrl}${route.path}` }));
    expect(built.sort()).toEqual(employeeRoutes.map(describeRoute).sort());
  });

  describe('Jack, a profile viewer', () => {
    it('views his own profile', async () => {
      const response = await (await as('jack')).get(PROFILE_PATH);
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ id: ID.JACK, name: 'Jack', manager: { id: ID.JASMIN } });
    });

    it('can not change his profile', async () => {
      const jack = await as('jack');
      const response = await jack.patch(PROFILE_PATH, { name: 'Jack Changed' });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('forbidden');
      expect((await jack.get(PROFILE_PATH)).body.name).toBe('Jack');
    });

    it('can not give himself the permission', async () => {
      const response = await (await as('jack')).put(`/users/${ID.JACK}/privileges`, { module: 'employee', permissions: ['profile.update'], reason: 'Please' });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('forbidden');
    });
  });

  it('refuses someone with no token, and someone with no Employee access', async () => {
    expect((await request(app).get(PROFILE_PATH)).status).toBe(401);
    expect((await (await as('karim')).get(PROFILE_PATH)).status).toBe(403);
  });

  describe('Jasmin, an HR Admin who manages Employee access', () => {
    it('gives Jack profile.update, which works on his next request, and takes it away', async () => {
      const jack = await as('jack');

      expect((await setJackPrivileges(['profile.update'])).status).toBe(200);
      const changed = await jack.patch(PROFILE_PATH, { name: 'Jack Changed' });
      expect(changed.status).toBe(200);
      expect(changed.body.name).toBe('Jack Changed');

      expect((await setJackPrivileges([])).status).toBe(200);
      expect((await jack.patch(PROFILE_PATH, { name: 'Jack Again' })).status).toBe(403);
    });

    it('takes away Jack\'s view by removing his role', async () => {
      const jack = await as('jack');
      const response = await (await as('jasmin')).patch(`/users/${ID.JACK}/roles`, { module: 'employee', role: null });
      expect(response.status).toBe(200);
      expect((await jack.get(PROFILE_PATH)).status).toBe(403);
    });

    it('holds HR Admin, and can change HR access too', async () => {
      const jasmin = await as('jasmin');
      expect((await jasmin.get('/me/permissions/hr')).body.role).toBe('admin');
      expect((await jasmin.patch(`/users/${ID.RAHIM}/roles`, { module: 'hr', role: 'viewer' })).status).toBe(200);
    });

    it('can only give what the Employee module marks grantable', async () => {
      const response = await setJackPrivileges(['role.update']);
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('not_grantable');
    });

    it('can not change Master access', async () => {
      const response = await (await as('jasmin')).patch(`/users/${ID.JACK}/roles`, { module: 'master', role: 'admin' });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('hr_roles_only');
    });

    it('gets this right from her Master role, so losing the role ends it', async () => {
      await (await as('farhana')).patch(`/users/${ID.JASMIN}/roles`, { module: 'master', role: null });
      const response = await setJackPrivileges(['profile.update']);
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('hr_roles_only');
    });
  });
});
