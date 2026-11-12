import type { Application } from 'express';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { parseOtpSecret, totpCode } from '../src/lib/totp.js';
import { AccessProfile } from '../src/modules/master/models/accessProfile.js';
import { Client } from '../src/modules/master/models/client.js';
import { RecordHistory } from '../src/modules/master/models/recordHistory.js';
import { ProjectCredential } from '../src/modules/tasks/models/projectCredential.js';
import { seedDatabase } from '../src/seed/seedDatabase.js';
import { useTestDatabase } from './helpers/database.js';
import { requestsAs, signIn } from './helpers/signedIn.js';
import { readSeedFiles } from './helpers/testAccess.js';
import { createTestConfig } from './helpers/testConfig.js';

const PASSWORD = 'correct-password';
const ID = { RAHIM: 'u_04', ARIF: 'u_07', MEHEDI: 'u_09', SUMAIYA: 'u_10' };
// The RFC 6238 test secret, "12345678901234567890", in base32.
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('Tasks: clients, project health, roster and logins', () => {
  useTestDatabase();

  let app: Application;
  const as = async (name: string) => requestsAs(app, await signIn(app, `${name}@twintrack.test`, PASSWORD));

  beforeAll(() => {
    app = createApp(createTestConfig({ ENCRYPTION_KEY: 'b'.repeat(64) }));
  });

  beforeEach(async () => {
    await seedDatabase({ files: readSeedFiles(), password: PASSWORD, nodeEnv: 'test' });
    await Client.create([
      { _id: 'cl_acme', name: 'Acme Ltd', status: 'active' },
      { _id: 'cl_old', name: 'Old Co', status: 'inactive' },
    ]);
  });

  const newProject = async (body: object = {}) => (await as('rahim')).post('/tasks/projects', { name: 'Payroll revamp', memberIds: [ID.MEHEDI], ...body });

  describe('one-time codes', () => {
    it('matches the RFC 6238 test vector', () => {
      expect(totpCode(RFC_SECRET, 59_000)).toEqual({ code: '287082', secondsRemaining: 1 });
      expect(totpCode(RFC_SECRET, 1_111_111_109_000).code).toBe('081804');
    });

    it('reads a secret from an otpauth link or with spaces, and refuses anything else', () => {
      expect(parseOtpSecret(`otpauth://totp/Acme:me?secret=${RFC_SECRET.toLowerCase()}&issuer=Acme`)).toBe(RFC_SECRET);
      expect(parseOtpSecret('GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ')).toBe(RFC_SECRET);
      expect(parseOtpSecret('not a secret!')).toBeNull();
      expect(parseOtpSecret('otpauth://totp/no-secret')).toBeNull();
    });
  });

  describe('clients on projects', () => {
    it('names an active Master client, and shows its name', async () => {
      const response = await newProject({ clientId: 'cl_acme' });
      expect(response.body).toMatchObject({ clientId: 'cl_acme', clientName: 'Acme Ltd' });
      expect((await (await as('rahim')).get('/tasks/projects')).body.projects[0].clientName).toBe('Acme Ltd');
    });

    it.each([['cl_old', 'is inactive'], ['cl_nobody', 'no such client']])('refuses the client %s', async (clientId, message) => {
      expect((await newProject({ clientId })).body.error.fields).toEqual([{ path: 'clientId', message }]);
    });

    it('can change the client later', async () => {
      const { body } = await newProject();
      expect((await (await as('rahim')).patch(`/tasks/projects/${body.id}`, { clientId: 'cl_acme' })).body.clientName).toBe('Acme Ltd');
    });
  });

  describe('health and roster', () => {
    async function finishTask() {
      const rahim = await as('rahim');
      const project = (await newProject({ totalAllocatedHours: 100 })).body;
      const task = (await rahim.post('/tasks/tasks', { projectId: project.id, title: 'Export', assignedDevId: ID.MEHEDI, estimatedHours: 4 })).body;
      await rahim.post('/tasks/tasks', { projectId: project.id, title: 'Still open', assignedDevId: ID.MEHEDI, estimatedHours: 2 });
      const mehedi = await as('mehedi');
      await mehedi.post(`/tasks/tasks/${task.id}/start`);
      await mehedi.post(`/tasks/tasks/${task.id}/complete`);
      await rahim.patch(`/tasks/tasks/${task.id}/actual-hours`, { actualHours: 5 });
      await rahim.post(`/tasks/tasks/${task.id}/approve`, { hours: { basis: 'estimated' } });
      return { rahim, project };
    }

    it('shows hours used against hours allocated, and who led this month', async () => {
      const { rahim, project } = await finishTask();
      expect((await rahim.get('/tasks/projects/health')).body.projects).toEqual([
        expect.objectContaining({
          id: project.id,
          leadName: 'Rahim Uddin',
          totalAllocatedHours: 100,
          completedHours: 5,
          usedShare: 0.05,
          openTaskCount: 1,
          // Hours used follow the timer. This month's led hours follow the approved 4, as incentives pay them.
          thisMonth: [{ tlId: ID.RAHIM, tlName: 'Rahim Uddin', hours: 4 }],
          // Rahim doesn't earn the monthly incentive, so this month's work costs nothing in incentives.
          thisMonthIncentive: 0,
        }),
      ]);
    });

    it('lists leads and developers with their stats and points', async () => {
      const { rahim } = await finishTask();
      expect((await rahim.get('/tasks/projects/roster')).body).toEqual({
        teamLeads: [{ id: ID.RAHIM, name: 'Rahim Uddin', projectCount: 1, tasksCompletedThisMonth: 1, averageVarianceHours: 1 }],
        developers: [{ id: ID.MEHEDI, name: 'Mehedi Hasan', openTasks: 1, completedTasks: 1, totalPoints: 200 }],
      });
    });

    it('keeps to the scope and to one lead when asked', async () => {
      const { rahim } = await finishTask();
      expect((await rahim.get(`/tasks/projects/health?leadId=${ID.SUMAIYA}`)).body.projects).toEqual([]);
      expect((await (await as('sumaiya')).get('/tasks/projects/health')).body.projects).toEqual([]);
    });
  });

  describe('project logins', () => {
    const login = { label: 'Salesforce sandbox', loginUrl: 'https://test.salesforce.com', username: 'dev@acme.test', password: 'Sup3r secret', otpSecret: RFC_SECRET, passcode: '4321' };

    async function withLogin() {
      const rahim = await as('rahim');
      const project = (await newProject()).body;
      const created = await rahim.post(`/tasks/projects/${project.id}/credentials`, login);
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      return { rahim, projectId: project.id as string, credential: created.body };
    }

    it('stores the secrets encrypted, and shows the password and the current code, never the code secret', async () => {
      const { credential } = await withLogin();
      expect(credential).toMatchObject({ label: 'Salesforce sandbox', password: 'Sup3r secret', passcode: '4321', hasOtp: true, otpCode: expect.stringMatching(/^\d{6}$/), createdByName: 'Rahim Uddin' });
      expect(credential).not.toHaveProperty('otpSecret');
      expect(credential.otpCode).toBe(totpCode(RFC_SECRET).code);

      const stored = JSON.stringify(await ProjectCredential.find().lean());
      for (const secret of ['Sup3r secret', '4321', RFC_SECRET]) expect(stored).not.toContain(secret);
    });

    it('keeps the secrets out of the history', async () => {
      const { rahim, projectId, credential } = await withLogin();
      await rahim.patch(`/tasks/projects/${projectId}/credentials/${credential.id}`, { password: 'Changed again', label: 'Sandbox' });
      const history = JSON.stringify(await RecordHistory.find({ object: 'credential' }).lean());
      expect(history).toContain('Sandbox');
      expect(history).not.toContain('Changed again');
      expect(history).not.toContain('Encrypted');
    });

    it('lets a member add a login but not change one, and shuts out people beyond the project', async () => {
      const { projectId, credential } = await withLogin();
      const mehedi = await as('mehedi');
      expect((await mehedi.get(`/tasks/projects/${projectId}/credentials`)).body.credentials).toHaveLength(1);
      expect((await mehedi.post(`/tasks/projects/${projectId}/credentials`, { ...login, label: 'Mine' })).status).toBe(201);
      expect((await mehedi.patch(`/tasks/projects/${projectId}/credentials/${credential.id}`, { label: 'Hijacked' })).status).toBe(403);
      expect((await (await as('sumaiya')).get(`/tasks/projects/${projectId}/credentials`)).body.error.code).toBe('out_of_scope');
    });

    it('can hide the password from a profile through field access', async () => {
      const { projectId } = await withLogin();
      await AccessProfile.updateOne({ _id: 'ap_developer' }, { $set: { 'grants.tasks.credential.fieldAccess': { password: 'hidden', otpCode: 'hidden' } } });
      const [seen] = (await (await as('mehedi')).get(`/tasks/projects/${projectId}/credentials`)).body.credentials;
      expect(seen).not.toHaveProperty('password');
      expect(seen).not.toHaveProperty('otpCode');
      expect(seen.username).toBe('dev@acme.test');
    });

    it('changes and clears values, and refuses a bad code secret', async () => {
      const { rahim, projectId, credential } = await withLogin();
      const path = `/tasks/projects/${projectId}/credentials/${credential.id}`;
      const cleared = (await rahim.patch(path, { otpSecret: null, passcode: null, version: 0 })).body;
      expect(cleared).toMatchObject({ hasOtp: false, version: 1 });
      expect(cleared).not.toHaveProperty('passcode');
      expect((await rahim.patch(path, { otpSecret: 'nope' })).body.error.fields[0].path).toBe('otpSecret');
      expect((await rahim.patch(path, { label: 'Old copy', version: 0 })).body.error.code).toBe('version_conflict');
    });

    it('moves a deleted login to the recycle bin', async () => {
      const { rahim, projectId, credential } = await withLogin();
      expect((await rahim.delete(`/tasks/projects/${projectId}/credentials/${credential.id}`)).body).toEqual({ deleted: true });
      expect((await rahim.get(`/tasks/projects/${projectId}/credentials`)).body.credentials).toEqual([]);
      expect(await ProjectCredential.findById(credential.id).setOptions({ withDeleted: true }).lean()).toMatchObject({ deletedBy: ID.RAHIM });
    });

    it.each([{ ...login, loginUrl: 'not a url' }, { ...login, password: '' }, { label: 'Missing parts' }])('refuses the body %#', async (body) => {
      const { rahim, projectId } = await withLogin();
      expect((await rahim.post(`/tasks/projects/${projectId}/credentials`, body)).status).toBe(422);
    });

    it('answers 404 for a login on another project', async () => {
      const { rahim, credential } = await withLogin();
      const other = (await newProject({ name: 'Other' })).body;
      expect((await rahim.patch(`/tasks/projects/${other.id}/credentials/${credential.id}`, { label: 'X' })).body.error.code).toBe('unknown_credential');
    });
  });
});
