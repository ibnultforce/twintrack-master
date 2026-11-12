import type { Application } from 'express';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { currentMonth } from '../src/lib/period.js';
import { AuditLog } from '../src/modules/master/models/auditLog.js';
import { IncentiveLedgerEntry } from '../src/modules/tasks/models/incentive.js';
import { Task } from '../src/modules/tasks/models/task.js';
import { seedDatabase } from '../src/seed/seedDatabase.js';
import { useTestDatabase } from './helpers/database.js';
import { requestsAs, signIn } from './helpers/signedIn.js';
import { readSeedFiles } from './helpers/testAccess.js';
import { createTestConfig } from './helpers/testConfig.js';

const PASSWORD = 'correct-password';
const ID = { RAHIM: 'u_04', MEHEDI: 'u_09', SUMAIYA: 'u_10' };
const DEFAULT_RATE = 100;

describe('Tasks: incentives', () => {
  useTestDatabase();

  let app: Application;
  const as = async (name: string) => requestsAs(app, await signIn(app, `${name}@twintrack.test`, PASSWORD));
  const month = currentMonth();

  beforeAll(() => {
    app = createApp(createTestConfig({ INCENTIVE_HOURLY_RATE_BDT: String(DEFAULT_RATE) }));
  });

  beforeEach(async () => {
    await seedDatabase({ files: readSeedFiles(), password: PASSWORD, nodeEnv: 'test' });
  });

  /** Rahim leads a project, and Mehedi finishes one task in it this month with the given hours. */
  async function finishedTask(actualHours: number) {
    const rahim = await as('rahim');
    const project = (await rahim.post('/tasks/projects', { name: 'Payroll revamp', memberIds: [ID.MEHEDI, ID.SUMAIYA] })).body;
    const task = (await rahim.post('/tasks/tasks', { projectId: project.id, title: 'Export', assignedDevId: ID.MEHEDI, estimatedHours: 4 })).body;
    const mehedi = await as('mehedi');
    await mehedi.post(`/tasks/tasks/${task.id}/start`);
    await mehedi.post(`/tasks/tasks/${task.id}/complete`);
    await Task.updateOne({ _id: task.id }, { $set: { actualHours } });
    await rahim.post(`/tasks/tasks/${task.id}/approve`, { hours: { basis: 'actual' } });
    return { rahim, projectId: project.id as string };
  }

  // Nobody changes or pays their own incentive, so the super admin does it for Rahim.
  const admin = () => as('farhana');

  const makeEarner = (rahim: Awaited<ReturnType<typeof as>>, userId: string, hourlyRate: number | null = null) =>
    rahim.put(`/tasks/incentives/settings/${userId}`, { earnsMonthlyIncentive: true, hourlyRate, eligibleForProjectIncentives: false });

  describe('monthly incentives', () => {
    it('pays nobody until their setting says they earn it', async () => {
      const { rahim } = await finishedTask(6);
      expect((await rahim.get('/tasks/incentives')).body).toMatchObject({ ...month, people: [], totalPayout: 0 });
    });

    it('pays the hours of finished tasks a person led, at the default rate', async () => {
      const { rahim } = await finishedTask(6);
      await makeEarner(await admin(), ID.RAHIM);
      const { body } = await rahim.get('/tasks/incentives');
      // Rahim is both the task's TL and the project's lead, so the task counts once.
      expect(body.people).toEqual([expect.objectContaining({ userId: ID.RAHIM, name: 'Rahim Uddin', completedHours: 6, hourlyRate: DEFAULT_RATE, totalPayout: 600, disbursed: false })]);
      expect(body.totalPayout).toBe(600);
    });

    it("prices this month's led hours in project health", async () => {
      const { rahim } = await finishedTask(6);
      await makeEarner(await admin(), ID.RAHIM);
      expect((await rahim.get('/tasks/projects/health')).body.projects[0].thisMonthIncentive).toBe(600);
    });

    it("uses a person's own rate when their setting names one", async () => {
      const { rahim } = await finishedTask(2.5);
      await makeEarner(await admin(), ID.RAHIM, 250);
      expect((await rahim.get('/tasks/incentives')).body.people[0]).toMatchObject({ hourlyRate: 250, totalPayout: 625 });
    });

    it('counts a past month by its own tasks', async () => {
      const { rahim } = await finishedTask(6);
      await makeEarner(await admin(), ID.RAHIM);
      expect((await rahim.get('/tasks/incentives?month=1&year=2001')).body.people[0]).toMatchObject({ completedHours: 0, totalPayout: 0 });
    });

    it('generates the ledger, pays it, and keeps a paid month frozen', async () => {
      const { rahim } = await finishedTask(6);
      await makeEarner(await admin(), ID.RAHIM);
      expect((await rahim.post('/tasks/incentives/generate', month)).body).toMatchObject({ generated: 1, skippedAsPaid: 0 });

      const farhana = await admin();
      const paid = await farhana.post('/tasks/incentives/disburse', { userId: ID.RAHIM, ...month });
      expect(paid.body).toMatchObject({ userId: ID.RAHIM, totalPayout: 600, disbursed: true, disbursedBy: 'u_01' });
      expect((await farhana.post('/tasks/incentives/disburse', { userId: ID.RAHIM, ...month })).body.error.code).toBe('already_paid');

      // More hours after payment change neither the paid entry nor what the month shows.
      await finishedTask(10);
      expect((await rahim.post('/tasks/incentives/generate', month)).body).toMatchObject({ generated: 0, skippedAsPaid: 1 });
      expect((await rahim.get('/tasks/incentives')).body.people[0]).toMatchObject({ totalPayout: 600, disbursed: true });
      expect(await IncentiveLedgerEntry.countDocuments()).toBe(1);
      expect(await AuditLog.exists({ action: 'incentive.disbursed', targetId: ID.RAHIM })).toBeTruthy();
    });

    it('pays the approved hours, so correcting the timer afterwards changes nothing', async () => {
      const rahim = await as('rahim');
      const project = (await rahim.post('/tasks/projects', { name: 'Payroll revamp', memberIds: [ID.MEHEDI] })).body;
      const task = (await rahim.post('/tasks/tasks', { projectId: project.id, title: 'Export', assignedDevId: ID.MEHEDI, estimatedHours: 4 })).body;
      const mehedi = await as('mehedi');
      await mehedi.post(`/tasks/tasks/${task.id}/start`);
      await mehedi.post(`/tasks/tasks/${task.id}/complete`);
      await Task.updateOne({ _id: task.id }, { $set: { actualHours: 12 } });
      await rahim.post(`/tasks/tasks/${task.id}/approve`, { hours: { basis: 'estimated' } });
      await makeEarner(await admin(), ID.RAHIM);
      expect((await rahim.get('/tasks/incentives')).body.people[0]).toMatchObject({ completedHours: 4, totalPayout: 400 });

      expect((await rahim.patch(`/tasks/tasks/${task.id}/actual-hours`, { actualHours: 40 })).status).toBe(200);
      expect((await rahim.get('/tasks/incentives')).body.people[0]).toMatchObject({ completedHours: 4, totalPayout: 400 });
      expect((await rahim.get('/tasks/projects/health')).body.projects[0].thisMonthIncentive).toBe(400);
    });

    it('refuses anyone changing, paying or giving their own incentive', async () => {
      const { rahim, projectId } = await finishedTask(6);
      expect((await makeEarner(rahim, ID.RAHIM, 10000)).body.error.code).toBe('own_incentive');
      await makeEarner(await admin(), ID.RAHIM);
      expect((await rahim.post('/tasks/incentives/disburse', { userId: ID.RAHIM, ...month })).body.error.code).toBe('own_incentive');
      expect((await rahim.put(`/tasks/projects/${projectId}/incentives/${ID.RAHIM}`, { enabled: true, amount: 5000 })).body.error.code).toBe('own_incentive');
      expect(await IncentiveLedgerEntry.countDocuments({ disbursed: true })).toBe(0);
    });

    it("refuses to pay someone who doesn't earn it", async () => {
      const { rahim } = await finishedTask(6);
      expect((await rahim.post('/tasks/incentives/disburse', { userId: ID.MEHEDI, ...month })).body.error.code).toBe('not_an_earner');
    });

    it('lists the ledger by person, newest first, within the scope', async () => {
      const { rahim } = await finishedTask(6);
      await makeEarner(await admin(), ID.RAHIM);
      await rahim.post('/tasks/incentives/generate', month);
      expect((await rahim.get(`/tasks/incentives/ledger?userId=${ID.RAHIM}`)).body.entries).toEqual([expect.objectContaining({ name: 'Rahim Uddin', totalPayout: 600 })]);

      // Mehedi's own scope reaches only himself.
      const mehedi = await as('mehedi');
      expect((await mehedi.get('/tasks/incentives/ledger')).body.entries).toEqual([]);
      expect((await mehedi.get(`/tasks/incentives/ledger?userId=${ID.RAHIM}`)).body.error.code).toBe('out_of_scope');
      expect((await mehedi.post('/tasks/incentives/generate', month)).status).toBe(403);
    });

    it.each([{ month: 13, year: 2026 }, { month: 1 }, { userId: 'u_04' }])('refuses the body %j', async (body) => {
      expect((await (await as('rahim')).post('/tasks/incentives/disburse', body)).status).toBe(422);
    });

    it('needs month and year together in the query', async () => {
      expect((await (await as('rahim')).get('/tasks/incentives?month=3')).status).toBe(422);
    });
  });

  describe('settings', () => {
    it('lists settings with the rate that applies, and clears a personal rate with null', async () => {
      const rahim = await as('rahim');
      await makeEarner(rahim, ID.MEHEDI, 300);
      const cleared = (await makeEarner(rahim, ID.MEHEDI, null)).body;
      expect(cleared.effectiveHourlyRate).toBe(DEFAULT_RATE);
      expect(cleared).not.toHaveProperty('hourlyRate');
      const { body } = await rahim.get('/tasks/incentives/settings');
      expect(body).toMatchObject({ defaultHourlyRate: DEFAULT_RATE, settings: [expect.objectContaining({ userId: ID.MEHEDI, earnsMonthlyIncentive: true })] });
    });

    it('refuses someone beyond the scope or who does not exist', async () => {
      const rahim = await as('rahim');
      expect((await makeEarner(rahim, 'u_05')).body.error.code).toBe('out_of_scope');
      expect((await makeEarner(rahim, 'u_nobody')).status).toBe(422);
    });
  });

  describe('project incentives', () => {
    it('lists members with eligibility, and gives one only to an eligible member', async () => {
      const { rahim, projectId } = await finishedTask(1);
      const notEligible = await rahim.put(`/tasks/projects/${projectId}/incentives/${ID.MEHEDI}`, { enabled: true, amount: 5000 });
      expect(notEligible.body.error.code).toBe('not_eligible');

      await rahim.put(`/tasks/incentives/settings/${ID.MEHEDI}`, { earnsMonthlyIncentive: false, hourlyRate: null, eligibleForProjectIncentives: true });
      const given = await rahim.put(`/tasks/projects/${projectId}/incentives/${ID.MEHEDI}`, { enabled: true, amount: 5000, notes: 'Shipped early' });
      expect(given.body).toMatchObject({ enabled: true, amount: 5000, notes: 'Shipped early' });

      const { members } = (await rahim.get(`/tasks/projects/${projectId}/incentives`)).body;
      expect(members).toEqual(expect.arrayContaining([
        expect.objectContaining({ userId: ID.MEHEDI, eligible: true, grant: expect.objectContaining({ amount: 5000, grantedByName: 'Rahim Uddin' }) }),
        expect.objectContaining({ userId: ID.SUMAIYA, eligible: false }),
      ]));

      const changed = await rahim.put(`/tasks/projects/${projectId}/incentives/${ID.MEHEDI}`, { enabled: false, amount: null });
      expect(changed.body).toMatchObject({ enabled: false });
      expect(changed.body).not.toHaveProperty('amount');
    });

    it('refuses someone who is not on the project', async () => {
      const { rahim, projectId } = await finishedTask(1);
      expect((await rahim.put(`/tasks/projects/${projectId}/incentives/u_05`, { enabled: true })).body.error.fields[0].path).toBe('userId');
    });
  });
});
