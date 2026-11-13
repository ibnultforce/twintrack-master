import type { Application } from 'express';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { AccessProfile } from '../src/modules/master/models/accessProfile.js';
import { User } from '../src/modules/master/models/user.js';
import { useTestDatabase } from './helpers/database.js';
import { addPerson, importSeedManifests, requestsAs, signIn, TEST_PASSWORD } from './helpers/signedIn.js';
import { createTestConfig } from './helpers/testConfig.js';

interface ListedRoute {
  method: string;
  path: string;
  access: string;
  permissions: string[];
  declaredAccess: string;
  isChanged: boolean;
  allowedAccess: string[];
}

describe('a super admin changing who may call an API', () => {
  useTestDatabase();

  let app: Application;
  const as = async (id: string) => requestsAs(app, await signIn(app, `${id}@twintrack.test`));

  const listedRoute = async (moduleKey: string, api: string): Promise<ListedRoute | undefined> => {
    const farhana = await as('farhana');
    const modules = (await farhana.get('/modules')).body.modules as { key: string; routes: ListedRoute[] }[];
    return modules.find((module) => module.key === moduleKey)!.routes.find((route) => `${route.method} ${route.path}` === api);
  };

  beforeAll(() => {
    app = createApp(createTestConfig());
  });

  beforeEach(async () => {
    await importSeedManifests();
    await addPerson('farhana', { superAdmin: true });
    await addPerson('karim');
    // Everything in Master, so the refusal below is about being a super admin, not about a missing permission.
    await AccessProfile.create({ _id: 'ap_module_admin', name: 'Module admin', grants: { master: '*' } });
    await addPerson('alia', { profileId: 'ap_module_admin' });
  });

  it('opens a private API to every signed-in person, reaching only their own records, and closes it again', async () => {
    const farhana = await as('farhana');
    const karim = await as('karim');
    expect((await karim.get('/hr/salaries')).status).toBe(403);

    const opened = await farhana.put('/modules/hr/route-access', { method: 'GET', path: '/hr/salaries', access: 'signed' });
    expect(opened.status).toBe(200);
    expect(opened.body.route).toMatchObject({ access: 'signed', permissions: [], declaredAccess: 'private', isChanged: true });
    expect((await karim.get('/hr/salaries')).status).toBe(200);

    const closed = await farhana.put('/modules/hr/route-access', { method: 'GET', path: '/hr/salaries', access: 'private' });
    expect(closed.body.route).toMatchObject({ access: 'private', permissions: ['salary.read'], isChanged: false });
    expect((await karim.get('/hr/salaries')).status).toBe(403);
  });

  it('makes a signed-in API private behind a permission, which applies on the next request', async () => {
    const farhana = await as('farhana');
    const karim = await as('karim');
    const alia = await as('alia');
    expect((await karim.get('/auth/me')).status).toBe(200);

    const changed = await farhana.put('/modules/master/route-access', { method: 'GET', path: '/auth/me', access: 'private', permission: 'user.read' });
    expect(changed.body.route).toMatchObject({ access: 'private', permissions: ['user.read'], declaredAccess: 'signed' });
    expect((await karim.get('/auth/me')).body.error.code).toBe('forbidden');
    expect((await alia.get('/auth/me')).status).toBe(200);
    expect((await farhana.get('/auth/me')).status).toBe(200);
    expect((await listedRoute('master', 'GET /auth/me'))?.isChanged).toBe(true);
  });

  it('changes which permission opens a private API', async () => {
    const farhana = await as('farhana');
    await AccessProfile.create({ _id: 'ap_reader', name: 'Reader', grants: { hr: { salary: { actions: ['read'], scope: 'all' } } } });
    await User.updateOne({ _id: 'karim' }, { $set: { profileId: 'ap_reader' } });
    const karim = await as('karim');
    expect((await karim.get('/hr/salaries')).status).toBe(200);

    await farhana.put('/modules/hr/route-access', { method: 'GET', path: '/hr/salaries', access: 'private', permission: 'salary.approve' });
    expect((await karim.get('/hr/salaries')).status).toBe(403);
  });

  it('keeps a change when the module manifest is imported again', async () => {
    const farhana = await as('farhana');
    await farhana.put('/modules/hr/route-access', { method: 'GET', path: '/hr/salaries', access: 'signed' });
    const hrManifest = (await farhana.get('/modules/hr/export')).body;
    expect((await farhana.post('/modules/import', { password: TEST_PASSWORD, manifest: hrManifest })).status).toBe(200);
    expect(await listedRoute('hr', 'GET /hr/salaries')).toMatchObject({ access: 'signed', isChanged: true });
  });

  it('refuses rules the API\'s code can\'t work with', async () => {
    const farhana = await as('farhana');
    const toPublic = await farhana.put('/modules/hr/route-access', { method: 'GET', path: '/hr/salaries', access: 'public' });
    expect(toPublic.status).toBe(422);
    expect(toPublic.body.error.code).toBe('access_not_allowed');

    const loginPrivate = await farhana.put('/modules/master/route-access', { method: 'POST', path: '/auth/login', access: 'signed' });
    expect(loginPrivate.body.error.code).toBe('access_not_allowed');
    expect(await listedRoute('master', 'POST /auth/login')).toMatchObject({ access: 'public', allowedAccess: ['public'] });
  });

  it('needs a real permission to make an API private', async () => {
    const farhana = await as('farhana');
    const withoutPermission = await farhana.put('/modules/master/route-access', { method: 'GET', path: '/auth/me', access: 'private' });
    expect(withoutPermission.status).toBe(422);
    const unknownPermission = await farhana.put('/modules/master/route-access', { method: 'GET', path: '/auth/me', access: 'private', permission: 'user.fly' });
    expect(unknownPermission.status).toBe(422);
    const unknownRoute = await farhana.put('/modules/master/route-access', { method: 'GET', path: '/nowhere', access: 'signed' });
    expect(unknownRoute.body.error.code).toBe('unknown_route');
  });

  it('is for super admins only, even with module.update', async () => {
    const alia = await as('alia');
    const refused = await alia.put('/modules/hr/route-access', { method: 'GET', path: '/hr/salaries', access: 'signed' });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('super_admin_only');
  });
});
