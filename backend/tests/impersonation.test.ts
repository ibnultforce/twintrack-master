import type { Application } from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { AuditLog } from '../src/modules/master/models/auditLog.js';
import { Session } from '../src/modules/master/models/session.js';
import { useTestDatabase } from './helpers/database.js';
import { addOrgRole, addPerson, importSeedManifests, requestsAs, signIn, TEST_PASSWORD } from './helpers/signedIn.js';
import { createTestConfig } from './helpers/testConfig.js';

describe('signing in as someone else, in development', () => {
  useTestDatabase();

  let app: Application;
  let disabledApp: Application;
  const as = async (id: string, onApp = app) => requestsAs(onApp, await signIn(onApp, `${id}@twintrack.test`));
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(() => {
    app = createApp(createTestConfig({ IMPERSONATION_ENABLED: 'true' }));
    disabledApp = createApp(createTestConfig());
  });

  beforeEach(async () => {
    await importSeedManifests();
    await addOrgRole('or_root');
    await addPerson('farhana', { name: 'Farhana Kabir', superAdmin: true, orgRoleId: 'or_root' });
    await addPerson('sadia', { name: 'Sadia Super', superAdmin: true, orgRoleId: 'or_root' });
    await addPerson('alia', { name: 'Alia Access', profileId: 'ap_access_admin', orgRoleId: 'or_root' });
    await addPerson('karim', { name: 'Karim Ahmed', profileId: 'ap_developer', orgRoleId: 'or_root' });
    await addPerson('jahid', { name: 'Jahid Rana', status: 'inactive', orgRoleId: 'or_root' });
  });

  const startAsKarim = async () => (await (await as('farhana')).post('/users/karim/impersonate')).body as { accessToken: string };

  it("gives a super admin a session that sees exactly what the person's access shows", async () => {
    const response = await (await as('farhana')).post('/users/karim/impersonate');
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toMatchObject({ expiresIn: 900, user: { id: 'karim', name: 'Karim Ahmed' } });
    expect(response.headers['set-cookie']).toBeUndefined();

    const asKarim = requestsAs(app, response.body.accessToken);
    expect((await asKarim.get('/auth/me')).body).toMatchObject({ id: 'karim', impersonatedBy: { id: 'farhana', name: 'Farhana Kabir' } });
    expect((await asKarim.get('/users')).status).toBe(403);
    expect((await asKarim.get('/me/permissions/tasks')).body.permissions).toMatchObject({ 'project.read': 'own', 'task.read': 'own' });
    expect((await asKarim.get('/me/permissions/tasks')).body.permissions).not.toHaveProperty('task.create');
    expect(await AuditLog.exists({ action: 'auth.impersonation_started', actorId: 'farhana', targetId: 'karim' })).toBeTruthy();
  });

  it("doesn't show a normal session as impersonated", async () => {
    expect((await (await as('karim')).get('/auth/me')).body).not.toHaveProperty('impersonatedBy');
  });

  it('tells the portal who may start it', async () => {
    expect((await (await as('farhana')).get('/auth/me')).body.canImpersonate).toBe(true);
    expect((await (await as('farhana', disabledApp)).get('/auth/me')).body.canImpersonate).toBe(false);
    expect((await (await as('alia')).get('/auth/me')).body.canImpersonate).toBe(false);
    expect((await requestsAs(app, (await startAsKarim()).accessToken).get('/auth/me')).body.canImpersonate).toBe(false);
  });

  it('still tells the portal after the super admin changes their name', async () => {
    const renamed = await (await as('farhana')).patch('/auth/me', { name: 'Farhana K.' });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ name: 'Farhana K.', canImpersonate: true });
  });

  it("hands back the super admin's own session when they stop, and ends the impersonation", async () => {
    const { accessToken } = await startAsKarim();
    const stopped = await request(app).post('/auth/stop-impersonating').set(bearer(accessToken));
    expect(stopped.status).toBe(200);

    expect((await requestsAs(app, stopped.body.accessToken).get('/auth/me')).body.id).toBe('farhana');
    expect((await request(app).get('/auth/me').set(bearer(accessToken))).status).toBe(401);
    expect(await AuditLog.exists({ action: 'auth.impersonation_stopped', actorId: 'farhana' })).toBeTruthy();
  });

  it("keeps the person's account and password out of reach while impersonating", async () => {
    const asKarim = requestsAs(app, (await startAsKarim()).accessToken);
    expect((await asKarim.patch('/auth/me', { name: 'Changed' })).body.error.code).toBe('impersonating');
    const change = await asKarim.post('/auth/change-password', { currentPassword: TEST_PASSWORD, newPassword: 'a-brand-new-password' });
    expect(change.body.error.code).toBe('impersonating');
    expect((await asKarim.post('/users/alia/impersonate')).body.error.code).toBe('forbidden');
  });

  it('refuses everyone but a super admin', async () => {
    const response = await (await as('alia')).post('/users/karim/impersonate');
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('forbidden');
  });

  it.each([
    ['another super admin', 'sadia', 403, 'super_admin_protected'],
    ['yourself', 'farhana', 409, 'own_account'],
    ['a deactivated person', 'jahid', 409, 'account_inactive'],
    ['someone who does not exist', 'nobody', 404, 'unknown_user'],
  ])('refuses %s', async (_label, targetId, status, code) => {
    const response = await (await as('farhana')).post(`/users/${targetId}/impersonate`);
    expect(response.status).toBe(status);
    expect(response.body.error.code).toBe(code);
  });

  it('refuses to stop when not impersonating', async () => {
    expect((await (await as('karim')).post('/auth/stop-impersonating')).body.error.code).toBe('not_impersonating');
  });

  it("ends the impersonation and asks for a new sign-in when the super admin's own session has ended", async () => {
    const { accessToken } = await startAsKarim();
    await Session.updateMany({ userId: 'farhana' }, { $set: { revokedAt: new Date() } });
    const stopped = await request(app).post('/auth/stop-impersonating').set(bearer(accessToken));
    expect(stopped.status).toBe(401);
    expect((await request(app).get('/auth/me').set(bearer(accessToken))).status).toBe(401);
  });

  it('is unavailable unless switched on, and switching it off ends running impersonations', async () => {
    const response = await (await as('farhana', disabledApp)).post('/users/karim/impersonate');
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('impersonation_disabled');

    const { accessToken } = await startAsKarim();
    expect((await request(disabledApp).get('/auth/me').set(bearer(accessToken))).status).toBe(401);
  });
});
