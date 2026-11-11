import type { Application } from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { AccessProfile } from '../src/modules/master/models/accessProfile.js';
import { AuditLog } from '../src/modules/master/models/auditLog.js';
import { PasswordLink } from '../src/modules/master/models/passwordLink.js';
import { Session } from '../src/modules/master/models/session.js';
import { User } from '../src/modules/master/models/user.js';
import { useTestDatabase } from './helpers/database.js';
import { addOrgRole, addPerson, importSeedManifests, requestsAs, signIn, TEST_PASSWORD } from './helpers/signedIn.js';
import { createTestConfig, TEST_ORIGIN } from './helpers/testConfig.js';
import { createRecordingEmailSender } from './helpers/testEmail.js';

const NEW_PASSWORD = 'a-brand-new-password';

describe('user administration', () => {
  useTestDatabase();

  let app: Application;
  const emails = createRecordingEmailSender();
  const as = async (id: string) => requestsAs(app, await signIn(app, `${id}@twintrack.test`));
  const setPassword = (token: string, newPassword = NEW_PASSWORD) =>
    request(app).post('/auth/set-password').set('Origin', TEST_ORIGIN).send({ token, newPassword });

  beforeAll(() => {
    app = createApp(createTestConfig({ PORTAL_URL: 'https://portal.twintrack.test' }), { emailSender: emails });
  });

  beforeEach(() => {
    emails.sent.length = 0;
    emails.failing = false;
  });

  beforeEach(async () => {
    await importSeedManifests();
    await addOrgRole('or_root');
    await addPerson('farhana', { name: 'Farhana Kabir', superAdmin: true });
    await addPerson('alia', { name: 'Alia Access', profileId: 'ap_access_admin' });
    await addPerson('sabbir', { name: 'Sabbir Alam', profileId: 'ap_hr_access' });
    await addPerson('rumana', { name: 'Rumana Akter', profileId: 'ap_auditor' });
    await addPerson('rahim', { name: 'Rahim Uddin', title: 'Engineering Lead', managerId: 'farhana', profileId: 'ap_engineering_lead' });
    await addPerson('karim', { name: 'Karim Ahmed', title: 'Backend Developer', managerId: 'rahim' });
    await addPerson('jahid', { name: 'Jahid Rana', status: 'inactive' });
  });

  describe('who can reach each route', () => {
    const adminRoutes: [string, 'get' | 'post' | 'patch' | 'put', string, object?][] = [
      ['list people', 'get', '/users'],
      ['add a person', 'post', '/users', { name: 'New', email: 'new@twintrack.test' }],
      ['access options', 'get', '/users/access-options'],
      ['read a person', 'get', '/users/rahim'],
      ['edit a person', 'patch', '/users/rahim', { title: 'Boss' }],
      ['set status', 'patch', '/users/rahim/status', { status: 'inactive' }],
      ['send password links', 'post', '/users/password-links', { userIds: ['rahim'] }],
      ['give a profile', 'put', '/users/rahim/profile', { profileId: null }],
    ];

    it.each(adminRoutes)('%s needs a token', async (_label, method, path) => {
      expect((await request(app)[method](path)).status).toBe(401);
    });

    it.each(adminRoutes)('%s is refused for someone with no Master role', async (_label, method, path, body) => {
      const karim = await as('karim');
      const response = await karim[method](path, body as object);
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('forbidden');
    });

    it('lets an auditor read people but change nothing', async () => {
      const auditor = await as('rumana');
      expect((await auditor.get('/users')).status).toBe(200);
      expect((await auditor.patch('/users/rahim', { title: 'Boss' })).status).toBe(403);
      expect((await auditor.put('/users/rahim/profile', { profileId: null })).status).toBe(403);
    });
  });

  describe('GET /users', () => {
    it('lists people by name with a total, and never password data', async () => {
      const response = await (await as('alia')).get('/users?pageSize=2');
      expect(response.status).toBe(200);
      expect(response.body.total).toBe(7);
      expect(response.body.users.map((user: { id: string }) => user.id)).toEqual(['alia', 'farhana']);
      expect(JSON.stringify(response.body)).not.toMatch(/passwordHash|argon2/);
    });

    it('moves through pages without repeating anyone', async () => {
      const admin = await as('alia');
      const first = await admin.get('/users?page=1&pageSize=4');
      const second = await admin.get('/users?page=2&pageSize=4');
      const ids = [...first.body.users, ...second.body.users].map((user: { id: string }) => user.id);
      expect(new Set(ids).size).toBe(7);
    });

    it('searches name, email and title, ignoring case', async () => {
      const admin = await as('alia');
      expect((await admin.get('/users?search=RAHIM')).body.total).toBe(1);
      expect((await admin.get('/users?search=karim@')).body.total).toBe(1);
      expect((await admin.get('/users?search=backend')).body.total).toBe(1);
    });

    it('treats regular expression characters in a search as plain text', async () => {
      const response = await (await as('alia')).get(`/users?search=${encodeURIComponent('.*')}`);
      expect(response.status).toBe(200);
      expect(response.body.total).toBe(0);
    });

    it('filters by status', async () => {
      const response = await (await as('alia')).get('/users?status=inactive');
      expect(response.body.users.map((user: { id: string }) => user.id)).toEqual(['jahid']);
    });

    it.each(['page=0', 'pageSize=1000', 'page=abc', 'status=gone'])('refuses the query %s', async (query) => {
      expect((await (await as('alia')).get(`/users?${query}`)).status).toBe(422);
    });
  });

  describe('POST /users', () => {
    const newPerson = { name: 'Nadia Noor', email: 'NADIA@twintrack.test', title: 'Analyst', managerId: 'rahim', orgRoleId: 'or_root' };

    it('adds a person and emails them a link to set their password', async () => {
      const response = await (await as('alia')).post('/users', newPerson);
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ invitationSent: true });
      expect(response.body.user).toMatchObject({
        name: 'Nadia Noor',
        email: 'nadia@twintrack.test',
        contract: 'permanent',
        status: 'active',
        superAdmin: false,
        orgRoleId: 'or_root',
      });
      expect(response.body.user.passwordHash).toBeUndefined();
      expect(response.body).not.toHaveProperty('temporaryPassword');

      const [email] = emails.sent;
      expect(email).toMatchObject({ to: 'nadia@twintrack.test', subject: 'Set up your TwinTrack account' });
      expect(email?.text).toContain('https://portal.twintrack.test/set-password?token=');
      expect(email?.html).toContain('Hi Nadia Noor,');
    });

    it('lets nobody sign in until the link is used, then the chosen password works', async () => {
      await (await as('alia')).post('/users', newPerson);
      const token = emails.latestLinkToken('nadia@twintrack.test');

      expect((await setPassword(token)).body).toEqual({ passwordSet: true });
      const nadia = requestsAs(app, await signIn(app, 'nadia@twintrack.test', NEW_PASSWORD));
      expect((await nadia.get('/me/modules')).body).toEqual({ modules: [] });
    });

    it('still adds the person when the email fails, and says so', async () => {
      emails.failing = true;
      const response = await (await as('alia')).post('/users', newPerson);
      expect(response.status).toBe(201);
      expect(response.body.invitationSent).toBe(false);
      expect(await User.exists({ email: 'nadia@twintrack.test' })).toBeTruthy();
    });

    it('escapes a name that looks like markup in the email', async () => {
      await (await as('alia')).post('/users', { ...newPerson, name: '<b>Nadia</b>' });
      expect(emails.sent[0]?.html).toContain('&lt;b&gt;Nadia&lt;/b&gt;');
      expect(emails.sent[0]?.html).not.toContain('<b>Nadia</b>');
    });

    it('records it, and stores only a hash of the link', async () => {
      const response = await (await as('alia')).post('/users', newPerson);
      const token = emails.latestLinkToken('nadia@twintrack.test');
      const entry = await AuditLog.findOne({ action: 'user.created' }).lean();
      expect(entry).toMatchObject({ actorId: 'alia', targetId: response.body.user.id, targetName: 'Nadia Noor' });

      const stored = JSON.stringify(await PasswordLink.find().lean()) + JSON.stringify(await AuditLog.find().lean());
      expect(stored).not.toContain(token);
    });

    it('refuses an email already in use, in any case', async () => {
      const response = await (await as('alia')).post('/users', { name: 'Copy', email: 'RAHIM@twintrack.test', orgRoleId: 'or_root' });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('email_taken');
      expect(await AuditLog.countDocuments({ action: 'user.created' })).toBe(0);
    });

    it('refuses a manager who does not exist', async () => {
      const response = await (await as('alia')).post('/users', { ...newPerson, managerId: 'nobody' });
      expect(response.status).toBe(422);
      expect(response.body.error.fields[0].path).toBe('managerId');
    });

    it('needs a place in the org tree', async () => {
      const response = await (await as('alia')).post('/users', { ...newPerson, orgRoleId: undefined });
      expect(response.status).toBe(422);
      expect(response.body.error.fields[0].path).toBe('orgRoleId');
    });

    it('refuses an org role that does not exist', async () => {
      const response = await (await as('alia')).post('/users', { ...newPerson, orgRoleId: 'or_nowhere' });
      expect(response.status).toBe(422);
      expect(response.body.error.fields[0].path).toBe('orgRoleId');
      expect(await User.countDocuments({ email: 'nadia@twintrack.test' })).toBe(0);
    });

    it.each([
      ['super admin', { superAdmin: true }],
      ['a profile, which has its own route', { profileId: 'ap_access_admin' }],
      ['a password hash', { passwordHash: 'x' }],
      ['an id', { _id: 'chosen' }],
    ])('refuses a request that tries to set %s', async (_label, extra) => {
      const response = await (await as('alia')).post('/users', { ...newPerson, ...extra });
      expect(response.status).toBe(422);
      expect(await User.countDocuments({ email: 'nadia@twintrack.test' })).toBe(0);
    });
  });

  describe('GET /users/access-options and /users/:id', () => {
    it('is not mistaken for a person called access-options', async () => {
      const response = await (await as('alia')).get('/users/access-options');
      expect(response.status).toBe(200);
      expect(response.body.modules.map((module: { key: string }) => module.key)).toEqual(['hr', 'master', 'tasks']);
    });

    it('lists every module to someone who reads people or gives profiles, and to nobody else', async () => {
      for (const id of ['alia', 'sabbir', 'rumana']) {
        expect((await (await as(id)).get('/users/access-options')).body.modules).toEqual([
          { key: 'hr', name: 'HR' },
          { key: 'master', name: 'Master' },
          { key: 'tasks', name: 'Tasks' },
        ]);
      }
    });

    it('returns one person, and 404 for anyone else', async () => {
      const admin = await as('alia');
      const response = await admin.get('/users/rahim');
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ id: 'rahim', name: 'Rahim Uddin', profileId: 'ap_engineering_lead' });
      expect(response.body.passwordHash).toBeUndefined();

      const missing = await admin.get('/users/nobody');
      expect(missing.status).toBe(404);
      expect(missing.body.error.code).toBe('unknown_user');
    });
  });

  describe('PATCH /users/:id', () => {
    it('changes details, clears a field with null, and records only what changed', async () => {
      const response = await (await as('alia')).patch('/users/rahim', { title: null, team: 'Platform', name: 'Rahim Uddin' });
      expect(response.status).toBe(200);
      expect(response.body.team).toBe('Platform');
      expect(response.body.title).toBeUndefined();

      const entry = await AuditLog.findOne({ action: 'user.updated' }).lean();
      expect(entry).toMatchObject({
        actorId: 'alia',
        targetId: 'rahim',
        before: { title: 'Engineering Lead', team: null },
        after: { title: null, team: 'Platform' },
      });
    });

    it('writes nothing when nothing changes', async () => {
      await (await as('alia')).patch('/users/rahim', { name: 'Rahim Uddin' });
      expect(await AuditLog.countDocuments({ action: 'user.updated' })).toBe(0);
    });

    it('refuses an email someone else uses', async () => {
      const response = await (await as('alia')).patch('/users/rahim', { email: 'karim@twintrack.test' });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('email_taken');
    });

    it.each([
      ['themselves', 'rahim', 'rahim'],
      ['someone who reports to them', 'rahim', 'karim'],
      ['someone who does not exist', 'rahim', 'nobody'],
    ])('refuses making a person report to %s', async (_label, id, managerId) => {
      const response = await (await as('alia')).patch(`/users/${id}`, { managerId });
      expect(response.status).toBe(422);
      expect(response.body.error.fields[0].path).toBe('managerId');
    });

    it('moves a person to a new manager, and removes one with null', async () => {
      const admin = await as('alia');
      expect((await admin.patch('/users/karim', { managerId: 'farhana' })).body.managerId).toBe('farhana');
      expect((await admin.patch('/users/karim', { managerId: null })).body.managerId).toBeUndefined();
    });

    it('moves a person to another org role, and refuses one that does not exist', async () => {
      await addOrgRole('or_engineering', 'or_root');
      const admin = await as('alia');
      expect((await admin.patch('/users/karim', { orgRoleId: 'or_engineering' })).body.orgRoleId).toBe('or_engineering');

      const response = await admin.patch('/users/karim', { orgRoleId: 'or_nowhere' });
      expect(response.status).toBe(422);
      expect(response.body.error.fields[0].path).toBe('orgRoleId');
    });

    it('lets nobody move themselves in the org tree', async () => {
      const response = await (await as('alia')).patch('/users/alia', { orgRoleId: 'or_root' });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('own_account');
    });

    it.each([
      ['no fields', {}],
      ['no org role', { orgRoleId: null }],
      ['super admin', { superAdmin: true }],
      ['a status', { status: 'inactive' }],
      ['a profile, which has its own route', { profileId: 'ap_access_admin' }],
      ['a blank name', { name: ' ' }],
      ['an object as a title', { title: { $ne: null } }],
    ])('refuses a request with %s', async (_label, body) => {
      expect((await (await as('alia')).patch('/users/rahim', body)).status).toBe(422);
    });

    it('protects a super admin from anyone but another super admin', async () => {
      const response = await (await as('alia')).patch('/users/farhana', { email: 'taken-over@twintrack.test' });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('super_admin_protected');

      await addPerson('tariq', { superAdmin: true });
      expect((await (await as('tariq')).patch('/users/farhana', { title: 'Founder' })).status).toBe(200);
    });
  });

  describe('PATCH /users/:id/status', () => {
    it('signs the person out everywhere on deactivation', async () => {
      const rahim = await as('rahim');
      expect((await rahim.get('/me/modules')).status).toBe(200);

      const response = await (await as('alia')).patch('/users/rahim/status', { status: 'inactive' });
      expect(response.status).toBe(200);
      expect(response.body.status).toBe('inactive');

      const refused = await rahim.get('/me/modules');
      expect(refused.status).toBe(401);
      expect(await Session.countDocuments({ userId: 'rahim', revokedAt: { $exists: false } })).toBe(0);
    });

    it('does not bring an old session back on reactivation', async () => {
      const rahim = await as('rahim');
      const admin = await as('alia');
      await admin.patch('/users/rahim/status', { status: 'inactive' });
      await admin.patch('/users/rahim/status', { status: 'active' });

      const refused = await rahim.get('/me/modules');
      expect(refused.status).toBe(401);
      expect(refused.body.error.code).toBe('session_revoked');
      await signIn(app, 'rahim@twintrack.test');
    });

    it('records each change once', async () => {
      const admin = await as('alia');
      await admin.patch('/users/rahim/status', { status: 'inactive' });
      await admin.patch('/users/rahim/status', { status: 'inactive' });
      await admin.patch('/users/rahim/status', { status: 'active' });
      expect(await AuditLog.countDocuments({ action: 'user.deactivated', targetId: 'rahim' })).toBe(1);
      expect(await AuditLog.countDocuments({ action: 'user.reactivated', targetId: 'rahim' })).toBe(1);
    });

    it('refuses deactivating yourself', async () => {
      const response = await (await as('alia')).patch('/users/alia/status', { status: 'inactive' });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('own_account');
    });

    it('refuses deactivating a super admin unless a super admin asks', async () => {
      const response = await (await as('alia')).patch('/users/farhana/status', { status: 'inactive' });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('super_admin_protected');
    });

    it('refuses any other status', async () => {
      expect((await (await as('alia')).patch('/users/rahim/status', { status: 'deleted' })).status).toBe(422);
    });
  });

  describe('POST /users/password-links', () => {
    const sendLinks = async (userIds: string[], by = 'alia') => (await as(by)).post('/users/password-links', { userIds });

    it('emails each person a reset link, and their current password works until they use it', async () => {
      const response = await sendLinks(['rahim', 'karim']);
      expect(response.status).toBe(200);
      expect(response.body.results).toEqual([
        { userId: 'rahim', email: 'rahim@twintrack.test', sent: true },
        { userId: 'karim', email: 'karim@twintrack.test', sent: true },
      ]);
      expect(emails.sent.map((email) => email.subject)).toEqual(['Set a new TwinTrack password', 'Set a new TwinTrack password']);
      expect((await signIn(app, 'rahim@twintrack.test')).length).toBeGreaterThan(0);
    });

    it('signs the person out everywhere once they set the new password, and the old one stops working', async () => {
      const rahim = await as('rahim');
      await sendLinks(['rahim']);
      expect((await setPassword(emails.latestLinkToken('rahim@twintrack.test'))).status).toBe(200);

      expect((await rahim.get('/me/modules')).status).toBe(401);
      const oldPassword = await request(app)
        .post('/auth/login')
        .set('Origin', TEST_ORIGIN)
        .send({ email: 'rahim@twintrack.test', password: TEST_PASSWORD });
      expect(oldPassword.status).toBe(401);
      expect(await AuditLog.exists({ action: 'auth.password_set', actorId: 'rahim' })).toBeTruthy();
    });

    it('lets a link be used only once', async () => {
      await sendLinks(['rahim']);
      const token = emails.latestLinkToken('rahim@twintrack.test');
      expect((await setPassword(token)).status).toBe(200);
      const again = await setPassword(token, 'yet-another-password');
      expect(again.status).toBe(400);
      expect(again.body.error.code).toBe('invalid_password_link');
    });

    it('makes an earlier link stop working when a newer one is sent', async () => {
      await sendLinks(['rahim']);
      const first = emails.latestLinkToken('rahim@twintrack.test');
      await sendLinks(['rahim']);
      expect((await setPassword(first)).body.error.code).toBe('invalid_password_link');
      expect((await setPassword(emails.latestLinkToken('rahim@twintrack.test'))).status).toBe(200);
    });

    it('refuses an expired link', async () => {
      await sendLinks(['rahim']);
      await PasswordLink.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
      expect((await setPassword(emails.latestLinkToken('rahim@twintrack.test'))).body.error.code).toBe('invalid_password_link');
    });

    it('refuses a short new password from a link', async () => {
      await sendLinks(['rahim']);
      expect((await setPassword(emails.latestLinkToken('rahim@twintrack.test'), 'short')).status).toBe(422);
    });

    it('reports each person it could not send to, and still sends the rest', async () => {
      const response = await sendLinks(['alia', 'farhana', 'jahid', 'nobody', 'karim']);
      expect(response.body.results).toEqual([
        { userId: 'alia', email: 'alia@twintrack.test', sent: false, error: 'own_account' },
        { userId: 'farhana', email: 'farhana@twintrack.test', sent: false, error: 'super_admin_protected' },
        { userId: 'jahid', email: 'jahid@twintrack.test', sent: false, error: 'account_inactive' },
        { userId: 'nobody', sent: false, error: 'unknown_user' },
        { userId: 'karim', email: 'karim@twintrack.test', sent: true },
      ]);
      expect(emails.sent).toHaveLength(1);
    });

    it('lets a super admin send a link to another super admin', async () => {
      await addPerson('sadia', { superAdmin: true });
      expect((await sendLinks(['sadia'], 'farhana')).body.results[0].sent).toBe(true);
    });

    it('says when the email could not be sent', async () => {
      emails.failing = true;
      expect((await sendLinks(['rahim'])).body.results).toEqual([{ userId: 'rahim', email: 'rahim@twintrack.test', sent: false, error: 'email_failed' }]);
    });

    it('logs the link being sent, but never the link', async () => {
      await sendLinks(['rahim']);
      const entries = JSON.stringify(await AuditLog.find({ action: 'user.password_link_sent' }).lean());
      expect(entries).toContain('"targetId":"rahim"');
      expect(entries).not.toContain(emails.latestLinkToken('rahim@twintrack.test'));
    });

    it.each([{}, { userIds: [] }, { userIds: ['rahim'], extra: true }])('refuses the body %j', async (body) => {
      expect((await (await as('alia')).post('/users/password-links', body)).status).toBe(422);
    });
  });

  describe('PUT /users/:id/profile', () => {
    beforeEach(async () => {
      // Within an HR access manager's own access: they read people in Master too.
      await AccessProfile.create({ _id: 'ap_reader', name: 'Reader', grants: { master: { user: { actions: ['read'] } } } });
      await AccessProfile.create({ _id: 'ap_staff', name: 'Staff', grants: { hr: { salary: { actions: ['read'], scope: 'own' } } } });
    });

    it('gives a profile, records it, and applies on the person\'s next request with the same token', async () => {
      const karim = await as('karim');
      expect((await karim.get('/me/permissions/hr')).body.hasAccess).toBe(false);

      const response = await (await as('farhana')).put('/users/karim/profile', { profileId: 'ap_staff' });
      expect(response.status).toBe(200);
      expect(response.body.profileId).toBe('ap_staff');
      expect((await karim.get('/me/permissions/hr')).body).toMatchObject({ profileName: 'Staff', permissions: { 'salary.read': 'own' } });
      expect(await AuditLog.findOne({ action: 'user.profile_changed' }).lean()).toMatchObject({
        actorId: 'farhana',
        targetId: 'karim',
        before: { profile: null },
        after: { profile: 'Staff' },
      });
    });

    it('takes the profile away with null', async () => {
      const response = await (await as('farhana')).put('/users/rahim/profile', { profileId: null });
      expect(response.status).toBe(200);
      expect(response.body.profileId).toBeUndefined();
      expect((await (await as('rahim')).get('/me/permissions/hr')).body.hasAccess).toBe(false);
    });

    it('writes nothing when nothing changes', async () => {
      const admin = await as('farhana');
      await admin.put('/users/karim/profile', { profileId: 'ap_staff' });
      await admin.put('/users/karim/profile', { profileId: 'ap_staff' });
      expect(await AuditLog.countDocuments({ action: 'user.profile_changed' })).toBe(1);
    });

    it('refuses a profile that does not exist', async () => {
      const response = await (await as('alia')).put('/users/karim/profile', { profileId: 'ap_ghost' });
      expect(response.status).toBe(422);
      expect(response.body.error.fields[0].path).toBe('profileId');
    });

    it('stops anyone changing their own profile', async () => {
      const response = await (await as('alia')).put('/users/alia/profile', { profileId: null });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('own_access');
    });

    it('leaves a super admin to other super admins', async () => {
      const response = await (await as('alia')).put('/users/farhana/profile', { profileId: 'ap_staff' });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('super_admin');
    });

    it('refuses giving a profile beyond the giver\'s own access, and replacing one beyond it', async () => {
      const sabbir = await as('sabbir');
      const beyond = await sabbir.put('/users/karim/profile', { profileId: 'ap_staff' });
      expect(beyond.status).toBe(403);
      expect(beyond.body.error.code).toBe('beyond_own_access');
      expect(beyond.body.error.message).toContain('salary.read');

      expect((await sabbir.put('/users/karim/profile', { profileId: 'ap_reader' })).status).toBe(200);
      const replacing = await sabbir.put('/users/rahim/profile', { profileId: 'ap_reader' });
      expect(replacing.status).toBe(403);
      expect(replacing.body.error.code).toBe('beyond_own_access');
    });

    it('reaches only the people the giver\'s scope covers', async () => {
      await AccessProfile.create({
        _id: 'ap_team_giver',
        name: 'Team giver',
        grants: { master: { user: { actions: ['read'] }, userProfile: { actions: ['update'], scope: 'team' } } },
      });
      await User.updateOne({ _id: 'rahim' }, { $set: { profileId: 'ap_team_giver' } });
      const rahim = await as('rahim');

      expect((await rahim.put('/users/karim/profile', { profileId: 'ap_reader' })).status).toBe(200);
      const outside = await rahim.put('/users/rumana/profile', { profileId: 'ap_reader' });
      expect(outside.status).toBe(403);
      expect(outside.body.error.code).toBe('out_of_scope');
    });

    it('needs userProfile.update, which user.update alone does not give', async () => {
      await AccessProfile.create({ _id: 'ap_editor', name: 'Editor', grants: { master: { user: { actions: ['read', 'update'] } } } });
      await User.updateOne({ _id: 'rahim' }, { $set: { profileId: 'ap_editor' } });
      const response = await (await as('rahim')).put('/users/karim/profile', { profileId: null });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('forbidden');
    });

    it.each([
      ['no profileId field', {}],
      ['an object as the profile', { profileId: { $ne: null } }],
      ['another field', { profileId: null, superAdmin: true }],
    ])('refuses %s', async (_label, body) => {
      expect((await (await as('alia')).put('/users/karim/profile', body)).status).toBe(422);
    });

    it('counts a person among a module\'s people when their profile gives access there', async () => {
      await (await as('farhana')).put('/users/karim/profile', { profileId: 'ap_staff' });
      const { body } = await (await as('alia')).get('/modules/hr/people');
      const karim = body.people.find((person: { id: string }) => person.id === 'karim');
      expect(karim).toMatchObject({ profile: { id: 'ap_staff', name: 'Staff' }, profilePermissions: { 'salary.read': 'own' } });
    });
  });

  describe('Rahim and Karim, from start to finish', () => {
    it('takes a new person from an emailed link to a profile that applies at once', async () => {
      const added = await (await as('alia')).post('/users', { name: 'Nadia Noor', email: 'nadia@twintrack.test', managerId: 'rahim', orgRoleId: 'or_root' });
      const nadiaId = added.body.user.id as string;

      await setPassword(emails.latestLinkToken('nadia@twintrack.test'));
      const nadia = requestsAs(app, await signIn(app, 'nadia@twintrack.test', NEW_PASSWORD));
      expect((await nadia.get('/me/modules')).body).toEqual({ modules: [] });

      const admin = await as('alia');
      await admin.put(`/users/${nadiaId}/profile`, { profileId: 'ap_developer' });
      expect((await nadia.get('/me/permissions/tasks')).body).toMatchObject({ profileName: 'Developer', permissions: { 'task.read': 'own' } });

      await admin.put(`/users/${nadiaId}/profile`, { profileId: null });
      expect((await nadia.get('/me/permissions/tasks')).body.hasAccess).toBe(false);
    });
  });
});
