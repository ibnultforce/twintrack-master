import type { Application } from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { Salary } from '../src/modules/hr/models/salary.js';
import { AccessProfile } from '../src/modules/master/models/accessProfile.js';
import { AuditLog } from '../src/modules/master/models/auditLog.js';
import { PasswordLink } from '../src/modules/master/models/passwordLink.js';
import { RecordShare } from '../src/modules/master/models/recordShare.js';
import { User } from '../src/modules/master/models/user.js';
import { UserPhoto } from '../src/modules/master/models/userPhoto.js';
import { useTestDatabase } from './helpers/database.js';
import { addOrgRole, addPerson, importSeedManifests, requestsAs, signIn, TEST_PASSWORD } from './helpers/signedIn.js';
import { createTestConfig } from './helpers/testConfig.js';
import { createRecordingEmailSender } from './helpers/testEmail.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a8ae0000000049454e44ae426082', 'hex');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

describe('people: numbers, photos, online status, directory and deleting', () => {
  useTestDatabase();

  let app: Application;
  const as = async (id: string) => requestsAs(app, await signIn(app, `${id}@twintrack.test`));
  const tokenOf = (id: string) => signIn(app, `${id}@twintrack.test`);
  const sendPhoto = (token: string, userId: string, body: Buffer, contentType = 'image/png') =>
    request(app).put(`/users/${userId}/photo`).set('Authorization', `Bearer ${token}`).set('Content-Type', contentType).send(body);

  beforeAll(() => {
    app = createApp(createTestConfig(), { emailSender: createRecordingEmailSender() });
  });

  beforeEach(async () => {
    await importSeedManifests();
    await addOrgRole('or_root');
    await addOrgRole('or_team', 'or_root');
    await AccessProfile.create({
      _id: 'ap_people_admin',
      name: 'People Admin',
      grants: { master: { user: { actions: ['read', 'create', 'update', 'delete'] }, presence: { actions: ['read'], scope: 'all' } } },
    });
    await AccessProfile.create({ _id: 'ap_team_presence', name: 'Team presence', grants: { master: { presence: { actions: ['read'], scope: 'team' } } } });
    await addPerson('farhana', { name: 'Farhana Kabir', superAdmin: true, orgRoleId: 'or_root' });
    await addPerson('alia', { name: 'Alia Access', profileId: 'ap_people_admin', orgRoleId: 'or_root' });
    await addPerson('rahim', { name: 'Rahim Uddin', title: 'Engineering Lead', profileId: 'ap_team_presence', orgRoleId: 'or_root' });
    await addPerson('karim', { name: 'Karim Ahmed', managerId: 'rahim', orgRoleId: 'or_team' });
    await addPerson('rumana', { name: 'Rumana Akter', profileId: 'ap_auditor', orgRoleId: 'or_root' });
    await addPerson('jahid', { name: 'Jahid Rana', status: 'inactive', orgRoleId: 'or_root' });
  });

  const addNadia = async () => {
    const response = await (await as('alia')).post('/users', { name: 'Nadia Noor', email: 'nadia@twintrack.test', orgRoleId: 'or_root' });
    return response.body.user.id as string;
  };

  describe('employee numbers', () => {
    it('hands out numbers in order to people as they are added', async () => {
      const admin = await as('alia');
      const first = await admin.post('/users', { name: 'One', email: 'one@twintrack.test', orgRoleId: 'or_root' });
      const second = await admin.post('/users', { name: 'Two', email: 'two@twintrack.test', orgRoleId: 'or_root' });
      expect([first.body.user.employeeNumber, second.body.user.employeeNumber]).toEqual([1, 2]);
    });

    it('previews the next number, and carries on above numbers given by hand', async () => {
      await User.updateOne({ _id: 'karim' }, { $set: { employeeNumber: 41 } });
      const admin = await as('alia');
      expect((await admin.get('/users/next-employee-number')).body).toEqual({ employeeNumber: 42 });
      expect((await admin.post('/users', { name: 'New', email: 'new@twintrack.test', orgRoleId: 'or_root' })).body.user.employeeNumber).toBe(42);
    });

    it('lets an admin change a number, and refuses one someone already has', async () => {
      await User.updateOne({ _id: 'karim' }, { $set: { employeeNumber: 7 } });
      const admin = await as('alia');
      expect((await admin.patch('/users/rahim', { employeeNumber: 12 })).body.employeeNumber).toBe(12);
      const taken = await admin.patch('/users/rahim', { employeeNumber: 7 });
      expect(taken.status).toBe(409);
      expect(taken.body.error.code).toBe('employee_number_taken');
    });

    it('still says so when an email is already used', async () => {
      const response = await (await as('alia')).patch('/users/rahim', { email: 'karim@twintrack.test' });
      expect(response.body.error.code).toBe('email_taken');
    });

    it.each([0, -3, 1.5, 'seven'])('refuses the number %j', async (employeeNumber) => {
      expect((await (await as('alia')).patch('/users/rahim', { employeeNumber })).status).toBe(422);
    });

    it('keeps the preview to people who may add someone', async () => {
      expect((await (await as('rumana')).get('/users/next-employee-number')).status).toBe(403);
    });
  });

  describe('photos', () => {
    it('lets someone set their own photo, which anyone signed in can then see', async () => {
      const response = await sendPhoto(await tokenOf('karim'), 'karim', PNG);
      expect(response.status).toBe(200);
      expect(response.body.photoUpdatedAt).toEqual(expect.any(String));

      const seen = await request(app).get('/users/karim/photo').set('Authorization', `Bearer ${await tokenOf('rumana')}`);
      expect(seen.status).toBe(200);
      expect(seen.headers['content-type']).toBe('image/png');
      expect(Buffer.compare(seen.body as Buffer, PNG)).toBe(0);
      expect((await (await as('alia')).get('/users/karim')).body.photoUpdatedAt).toEqual(response.body.photoUpdatedAt);
    });

    it('tells the type from the bytes, not from what the request claims', async () => {
      await sendPhoto(await tokenOf('karim'), 'karim', JPEG, 'image/png');
      expect((await UserPhoto.findById('karim').lean())?.contentType).toBe('image/jpeg');
    });

    it('refuses something that is not an image', async () => {
      const response = await sendPhoto(await tokenOf('karim'), 'karim', Buffer.from('<svg onload="alert(1)"></svg>'));
      expect(response.status).toBe(415);
      expect(response.body.error.code).toBe('unsupported_photo');
    });

    it('refuses a body sent as another content type', async () => {
      const response = await request(app).put('/users/karim/photo').set('Authorization', `Bearer ${await tokenOf('karim')}`).send({ image: 'x' });
      expect(response.status).toBe(422);
    });

    it('refuses an image over 2 MB', async () => {
      const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]);
      expect((await sendPhoto(await tokenOf('karim'), 'karim', big)).status).toBe(413);
    });

    it("keeps people from changing someone else's photo without user.update", async () => {
      const response = await sendPhoto(await tokenOf('rumana'), 'karim', PNG);
      expect(response.status).toBe(403);
    });

    it("lets an admin with user.update change someone's photo, but not a super admin's", async () => {
      const admin = await tokenOf('alia');
      expect((await sendPhoto(admin, 'karim', PNG)).status).toBe(200);
      expect((await sendPhoto(admin, 'farhana', PNG)).body.error.code).toBe('super_admin_protected');
    });

    it('removes a photo and logs both changes', async () => {
      await sendPhoto(await tokenOf('karim'), 'karim', PNG);
      expect((await (await as('karim')).delete('/users/karim/photo')).body).toEqual({ removed: true });
      expect((await (await as('rumana')).get('/users/karim/photo')).status).toBe(404);
      expect((await User.findById('karim').lean())?.photoUpdatedAt).toBeUndefined();
      expect(await AuditLog.find({ targetId: 'karim' }).distinct('action')).toEqual(expect.arrayContaining(['user.photo_changed', 'user.photo_removed']));
    });

    it('needs a session to see a photo', async () => {
      expect((await request(app).get('/users/karim/photo')).status).toBe(401);
    });
  });

  describe('online status', () => {
    it('shows someone as online after their app reports in', async () => {
      const karim = await as('karim');
      expect((await karim.post('/me/heartbeat')).status).toBe(204);
      const { body } = await (await as('alia')).get('/users/karim');
      expect(body.online).toBe(true);
    });

    it('counts signing in as being seen, and shows offline once reports stop', async () => {
      await tokenOf('karim');
      expect((await (await as('alia')).get('/users/karim')).body.online).toBe(true);
      await User.updateOne({ _id: 'karim' }, { $set: { lastSeenAt: new Date(Date.now() - 10 * 60_000) } });
      expect((await (await as('alia')).get('/users/karim')).body.online).toBe(false);
    });

    it('only shows it to people whose presence.read scope reaches the person', async () => {
      await tokenOf('karim');
      await tokenOf('farhana');
      const rahim = await as('rahim');
      const people = (await rahim.get('/directory')).body.people as { id: string; online?: boolean }[];
      expect(people.find((person) => person.id === 'karim')).toHaveProperty('online', true);
      expect(people.find((person) => person.id === 'alia')).not.toHaveProperty('online');

      const auditor = (await (await as('rumana')).get('/users')).body.users as { online?: boolean }[];
      expect(auditor.every((person) => !('online' in person))).toBe(true);
    });

    it('records when someone last signed in', async () => {
      await tokenOf('karim');
      expect((await (await as('alia')).get('/users/karim')).body.lastSignedInAt).toEqual(expect.any(String));
    });
  });

  describe('GET /directory', () => {
    it('lists active colleagues for anyone signed in, without super admins or access details', async () => {
      const { body } = await (await as('karim')).get('/directory');
      expect(body.people.map((person: { id: string }) => person.id)).toEqual(['alia', 'karim', 'rahim', 'rumana']);
      expect(body.total).toBe(4);
      expect(body.people[2]).toEqual({ id: 'rahim', name: 'Rahim Uddin', email: 'rahim@twintrack.test', title: 'Engineering Lead' });
    });

    it('searches by name, email or title', async () => {
      const { body } = await (await as('karim')).get('/directory?search=engineering');
      expect(body.people.map((person: { id: string }) => person.id)).toEqual(['rahim']);
    });

    it('needs a session', async () => {
      expect((await request(app).get('/directory')).status).toBe(401);
    });
  });

  describe('DELETE /users/:id', () => {
    it('removes someone who never signed in, with their link and anything shared with them', async () => {
      const nadiaId = await addNadia();
      await RecordShare.create({ _id: 'rs_1', module: 'hr', object: 'salary', recordId: 's_1', granteeType: 'user', granteeId: nadiaId, access: 'read', sharedBy: 'alia' });

      const response = await (await as('alia')).delete(`/users/${nadiaId}`);
      expect(response.body).toEqual({ deleted: true });
      expect(await User.exists({ _id: nadiaId })).toBeNull();
      expect(await PasswordLink.exists({ userId: nadiaId })).toBeNull();
      expect(await RecordShare.exists({ granteeId: nadiaId })).toBeNull();
      expect(await AuditLog.findOne({ action: 'user.deleted' }).lean()).toMatchObject({ targetId: nadiaId, before: { name: 'Nadia Noor' } });
    });

    it('refuses someone who has signed in, who can only be deactivated', async () => {
      await tokenOf('karim');
      const response = await (await as('alia')).delete('/users/karim');
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('has_signed_in');
    });

    it('refuses someone another module still names, and says what names them', async () => {
      const nadiaId = await addNadia();
      await Salary.create({ _id: 's_1', employeeId: nadiaId, amount: 1000, currency: 'BDT', effectiveFrom: new Date() });
      const response = await (await as('alia')).delete(`/users/${nadiaId}`);
      expect(response.status).toBe(409);
      expect(response.body.error).toMatchObject({ code: 'user_in_use', message: expect.stringContaining('salary records') });
    });

    it('refuses someone people report to', async () => {
      const nadiaId = await addNadia();
      await User.updateOne({ _id: 'karim' }, { $set: { managerId: nadiaId } });
      expect((await (await as('alia')).delete(`/users/${nadiaId}`)).body.error.message).toContain('people who report to them');
    });

    it('refuses your own account and a super admin', async () => {
      await addPerson('sadia', { superAdmin: true });
      const admin = await as('alia');
      expect((await admin.delete('/users/alia')).body.error.code).toBe('own_account');
      expect((await admin.delete('/users/sadia')).body.error.code).toBe('super_admin_protected');
    });

    it('needs user.delete', async () => {
      const nadiaId = await addNadia();
      expect((await (await as('rumana')).delete(`/users/${nadiaId}`)).status).toBe(403);
    });

    it('answers 404 for someone who does not exist', async () => {
      expect((await (await as('alia')).delete('/users/nobody')).status).toBe(404);
    });
  });

  describe('POST /auth/verify-password', () => {
    it('confirms the right password', async () => {
      const response = await (await as('karim')).post('/auth/verify-password', { password: TEST_PASSWORD });
      expect(response.body).toEqual({ verified: true });
    });

    it('refuses a wrong one without ending the session', async () => {
      const karim = await as('karim');
      const response = await karim.post('/auth/verify-password', { password: 'wrong-password' });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('wrong_current_password');
      expect((await karim.get('/auth/me')).status).toBe(200);
    });

    it.each([{}, { password: '' }, { password: 'x', extra: 1 }])('refuses the body %j', async (body) => {
      expect((await (await as('karim')).post('/auth/verify-password', body)).status).toBe(422);
    });
  });
});
