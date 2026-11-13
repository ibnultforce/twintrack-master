import type { Application } from 'express';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { AccessProfile } from '../src/modules/master/models/accessProfile.js';
import { User } from '../src/modules/master/models/user.js';
import { PointsEntry } from '../src/modules/tasks/models/pointsEntry.js';
import { Task } from '../src/modules/tasks/models/task.js';
import { seedDatabase } from '../src/seed/seedDatabase.js';
import { useTestDatabase } from './helpers/database.js';
import { requestsAs, signIn } from './helpers/signedIn.js';
import { readSeedFiles } from './helpers/testAccess.js';
import { createTestConfig } from './helpers/testConfig.js';

const PASSWORD = 'correct-password';
// Rahim leads engineering with a team scope. Arif, Mehedi and Sumaiya are developers who see their own work.
const ID = { RAHIM: 'u_04', ARIF: 'u_07', MEHEDI: 'u_09', SUMAIYA: 'u_10', KAMRUL: 'u_06' };

describe('Tasks: points, QA tasks, flags, billing and reporting', () => {
  useTestDatabase();

  let app: Application;
  const as = async (name: string) => requestsAs(app, await signIn(app, `${name}@twintrack.test`, PASSWORD));

  beforeAll(() => {
    app = createApp(createTestConfig());
  });

  beforeEach(async () => {
    await seedDatabase({ files: readSeedFiles(), password: PASSWORD, nodeEnv: 'test' });
  });

  async function setUp(task: Record<string, unknown> = {}) {
    const rahim = await as('rahim');
    const project = await rahim.post('/tasks/projects', { name: 'Payroll revamp', memberIds: [ID.ARIF, ID.MEHEDI] });
    const created = await rahim.post('/tasks/tasks', { projectId: project.body.id, title: 'Build the export', assignedDevId: ID.ARIF, estimatedHours: 8, ...task });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return { rahim, projectId: project.body.id as string, taskId: created.body.id as string, task: created.body };
  }

  async function workThrough(taskId: string, name = 'arif', body?: object) {
    const person = await as(name);
    expect((await person.post(`/tasks/tasks/${taskId}/start`)).status).toBe(200);
    const completed = await person.post(`/tasks/tasks/${taskId}/complete`, body);
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);
    return person;
  }

  const pointsOf = async (userId: string) => (await PointsEntry.find({ userId }).lean()).reduce((sum, entry) => sum + entry.points, 0);

  describe('creating tasks', () => {
    it('is worth 50 points an hour, billable unless said otherwise', async () => {
      const { task } = await setUp();
      expect(task).toMatchObject({ pointValue: 400, billable: true, flagged: false, kind: 'development' });
      const internal = await setUp({ title: 'Team meeting', billable: false, estimatedHours: 1 });
      expect(internal.task).toMatchObject({ billable: false, pointValue: 50 });
    });

    it('refuses a due date in the past, but takes today', async () => {
      const { rahim, projectId } = await setUp();
      const past = await rahim.post('/tasks/tasks', { projectId, title: 'Late', assignedDevId: ID.ARIF, estimatedHours: 1, dueDate: '2020-01-01' });
      expect(past.status).toBe(422);
      expect(past.body.error.fields[0]).toEqual({ path: 'dueDate', message: "can't be in the past" });
      const today = new Date().toISOString().slice(0, 10);
      expect((await rahim.post('/tasks/tasks', { projectId, title: 'Today', assignedDevId: ID.ARIF, estimatedHours: 1, dueDate: today })).status).toBe(201);
    });

    it('needs an estimate, except on a QA task a tester adds for themselves', async () => {
      const { rahim, projectId } = await setUp();
      const missing = await rahim.post('/tasks/tasks', { projectId, title: 'No estimate', assignedDevId: ID.ARIF });
      expect(missing.body.error.fields[0].path).toBe('estimatedHours');

      // Mehedi needs to create tasks to add his own. Developers otherwise only read them.
      await AccessProfile.updateOne({ _id: 'ap_developer' }, { $set: { 'grants.tasks.task.actions': ['read', 'create'] } });
      const ownQa = await (await as('mehedi')).post('/tasks/tasks', { projectId, title: 'Write test cases', assignedDevId: ID.MEHEDI, kind: 'qa' });
      expect(ownQa.status, JSON.stringify(ownQa.body)).toBe(201);
      expect(ownQa.body).toMatchObject({ kind: 'qa', estimatedHours: 0, pointValue: 0 });

      const forSomeoneElse = await rahim.post('/tasks/tasks', { projectId, title: 'QA for Mehedi', assignedDevId: ID.MEHEDI, kind: 'qa' });
      expect(forSomeoneElse.status).toBe(422);
    });

    it('can point to other tasks from the start', async () => {
      const { rahim, projectId, taskId } = await setUp();
      const linked = await rahim.post('/tasks/tasks', { projectId, title: 'Follow-up', assignedDevId: ID.ARIF, estimatedHours: 2, referencedTaskIds: [taskId] });
      expect((await rahim.get(`/tasks/tasks/${linked.body.id}`)).body.references).toEqual([expect.objectContaining({ id: taskId })]);
      const unknown = await rahim.post('/tasks/tasks', { projectId, title: 'Bad link', assignedDevId: ID.ARIF, estimatedHours: 2, referencedTaskIds: ['t_nobody'] });
      expect(unknown.body.error.fields[0].path).toBe('referencedTaskIds');
    });

    it('moves the points with the estimate until the task is done', async () => {
      const { rahim, taskId } = await setUp();
      expect((await rahim.patch(`/tasks/tasks/${taskId}`, { estimatedHours: 3 })).body.pointValue).toBe(150);
    });
  });

  describe('points', () => {
    it('awards the approved hours to the assignee, and the QA hours to QA, once', async () => {
      const { rahim, taskId } = await setUp();
      await workThrough(taskId);
      await rahim.post(`/tasks/tasks/${taskId}/qa-handover`, { qaId: ID.MEHEDI, qaEstimatedHours: 2 });
      const mehedi = await as('mehedi');
      await mehedi.post(`/tasks/tasks/${taskId}/qa-start`);
      await mehedi.post(`/tasks/tasks/${taskId}/qa-complete`, { result: 'pass' });
      const approved = await rahim.post(`/tasks/tasks/${taskId}/approve`, { hours: { basis: 'estimated' }, qaHours: { basis: 'estimated' } });
      expect(approved.body).toMatchObject({ status: 'done', pointValue: 400, qaPointValue: 100 });
      expect(await pointsOf(ID.ARIF)).toBe(400);
      expect(await pointsOf(ID.MEHEDI)).toBe(100);
    });

    it('takes back the approval and 5% more from whoever did the work on a revert, and can give the fix to someone else', async () => {
      const { rahim, taskId } = await setUp();
      await workThrough(taskId);
      await rahim.post(`/tasks/tasks/${taskId}/approve`, { hours: { basis: 'estimated' } });
      const reverted = await rahim.post(`/tasks/tasks/${taskId}/revert`, { comment: 'Breaks the totals', assignedDevId: ID.MEHEDI });
      expect(reverted.body).toMatchObject({ status: 'reverted', assignedDevId: ID.MEHEDI, revertCount: 1, workedSeconds: 0 });
      expect(reverted.body).not.toHaveProperty('actualHours');
      expect(await pointsOf(ID.ARIF)).toBe(-20);
      expect(await PointsEntry.findOne({ reason: 'approval_reversed' }).lean()).toMatchObject({ userId: ID.ARIF, points: -400 });
      expect(await PointsEntry.findOne({ reason: 'revert_penalty' }).lean()).toMatchObject({ userId: ID.ARIF, points: -20, createdBy: ID.RAHIM });

      // Approving the fix pays whoever fixed it, once.
      await workThrough(taskId, 'mehedi');
      await rahim.post(`/tasks/tasks/${taskId}/approve`, { hours: { basis: 'estimated' } });
      expect(await pointsOf(ID.MEHEDI)).toBe(400);
      expect(await pointsOf(ID.ARIF)).toBe(-20);
    });

    it('counts a task approved, reverted and approved again once, and takes QA points back too', async () => {
      const { rahim, taskId } = await setUp();
      await workThrough(taskId);
      await rahim.post(`/tasks/tasks/${taskId}/qa-handover`, { qaId: ID.MEHEDI, qaEstimatedHours: 2 });
      const mehedi = await as('mehedi');
      await mehedi.post(`/tasks/tasks/${taskId}/qa-start`);
      await mehedi.post(`/tasks/tasks/${taskId}/qa-complete`, { result: 'pass' });
      await rahim.post(`/tasks/tasks/${taskId}/approve`, { hours: { basis: 'estimated' }, qaHours: { basis: 'estimated' } });
      await rahim.post(`/tasks/tasks/${taskId}/revert`, { comment: 'Found a bug' });
      expect(await pointsOf(ID.MEHEDI)).toBe(0);

      await workThrough(taskId);
      await rahim.post(`/tasks/tasks/${taskId}/approve`, { hours: { basis: 'estimated' } });
      expect(await pointsOf(ID.ARIF)).toBe(400 - 20);
    });

    it('takes the 5% penalty, and nothing else, on a revert before approval', async () => {
      const { rahim, taskId } = await setUp();
      await workThrough(taskId);
      await rahim.post(`/tasks/tasks/${taskId}/revert`, { comment: 'Not ready' });
      expect(await pointsOf(ID.ARIF)).toBe(-20);
      expect(await PointsEntry.countDocuments({ reason: 'approval_reversed' })).toBe(0);
    });

    it('refuses to give the fix to someone off the project', async () => {
      const { rahim, taskId } = await setUp();
      await workThrough(taskId);
      const response = await rahim.post(`/tasks/tasks/${taskId}/revert`, { comment: 'Again', assignedDevId: ID.SUMAIYA });
      expect(response.body.error.fields[0].path).toBe('assignedDevId');
    });

    it('lists totals within the scope, and one person with where their points came from', async () => {
      const { rahim, taskId } = await setUp();
      await workThrough(taskId);
      await rahim.post(`/tasks/tasks/${taskId}/approve`, { hours: { basis: 'estimated' } });

      const team = (await rahim.get('/tasks/points')).body;
      expect(team.people).toEqual([expect.objectContaining({ userId: ID.ARIF, name: 'Arif Chowdhury', totalPoints: 400 })]);

      expect((await rahim.get(`/tasks/points/${ID.ARIF}`)).body).toMatchObject({
        totalPoints: 400,
        entries: [expect.objectContaining({ points: 400, reason: 'task_approved', taskNumber: expect.stringMatching(/^T-/), taskTitle: 'Build the export' })],
      });
      // A developer's own scope reaches only themselves.
      const mehedi = await as('mehedi');
      expect((await mehedi.get(`/tasks/points/${ID.MEHEDI}`)).body).toMatchObject({ totalPoints: 0, entries: [] });
      expect((await mehedi.get(`/tasks/points/${ID.ARIF}`)).body.error.code).toBe('out_of_scope');
      expect((await (await as('karim')).get('/tasks/points')).status).toBe(403);
    });

    it('counts from a date, such as the start of a review cycle', async () => {
      const { rahim, taskId } = await setUp();
      await workThrough(taskId);
      await rahim.post(`/tasks/tasks/${taskId}/approve`, { hours: { basis: 'estimated' } });
      expect((await rahim.get('/tasks/points?since=2999-01-01')).body.people).toEqual([]);
    });

    it('never shows a total below zero', async () => {
      await PointsEntry.create({ _id: 'pe_1', userId: ID.ARIF, taskId: 't_1', projectId: 'p_1', points: -50, reason: 'revert_penalty', createdBy: ID.RAHIM });
      expect((await (await as('rahim')).get(`/tasks/points/${ID.ARIF}`)).body.totalPoints).toBe(0);
    });
  });

  describe('QA tasks and the QA estimate', () => {
    async function qaTask() {
      const { rahim, projectId } = await setUp();
      const created = await rahim.post('/tasks/tasks', { projectId, title: 'Regression pass', assignedDevId: ID.MEHEDI, estimatedHours: 3, kind: 'qa' });
      return { rahim, taskId: created.body.id as string };
    }

    it('records pass or fail when a QA task is completed, and is never handed to QA', async () => {
      const { rahim, taskId } = await qaTask();
      const mehedi = await as('mehedi');
      await mehedi.post(`/tasks/tasks/${taskId}/start`);
      expect((await mehedi.post(`/tasks/tasks/${taskId}/complete`)).body.error.fields[0].path).toBe('result');
      expect((await mehedi.post(`/tasks/tasks/${taskId}/complete`, { result: 'fail' })).body).toMatchObject({ status: 'pending_approval', qaResult: 'fail' });
      expect((await rahim.post(`/tasks/tasks/${taskId}/qa-handover`, { qaId: ID.ARIF })).body.error.code).toBe('qa_task');
    });

    it('refuses a result on an ordinary task', async () => {
      const { taskId } = await setUp();
      const arif = await as('arif');
      await arif.post(`/tasks/tasks/${taskId}/start`);
      expect((await arif.post(`/tasks/tasks/${taskId}/complete`, { result: 'pass' })).status).toBe(422);
    });

    it('keeps QA from starting until there is an estimate, which locks once QA starts', async () => {
      const { rahim, taskId } = await setUp();
      await workThrough(taskId);
      await rahim.post(`/tasks/tasks/${taskId}/qa-handover`, { qaId: ID.MEHEDI });
      const mehedi = await as('mehedi');
      expect((await mehedi.post(`/tasks/tasks/${taskId}/qa-start`)).body.error.code).toBe('qa_estimate_missing');

      expect((await rahim.patch(`/tasks/tasks/${taskId}/qa-estimate`, { qaEstimatedHours: 1.5 })).body).toMatchObject({ qaEstimatedHours: 1.5, qaPointValue: 75 });
      expect((await mehedi.post(`/tasks/tasks/${taskId}/qa-start`)).status).toBe(200);
      expect((await rahim.patch(`/tasks/tasks/${taskId}/qa-estimate`, { qaEstimatedHours: 4 })).body.error.code).toBe('qa_estimate_locked');
    });

    it('lets a task that reached QA without an estimate get one, so QA can resume', async () => {
      const { rahim, taskId } = await setUp();
      await workThrough(taskId);
      await rahim.post(`/tasks/tasks/${taskId}/qa-handover`, { qaId: ID.MEHEDI, qaEstimatedHours: 1 });
      const mehedi = await as('mehedi');
      await mehedi.post(`/tasks/tasks/${taskId}/qa-start`);
      await mehedi.post(`/tasks/tasks/${taskId}/qa-pause`);
      // As a task handed over before estimates were required.
      await Task.updateOne({ _id: taskId }, { $unset: { qaEstimatedHours: 1 } });
      expect((await mehedi.post(`/tasks/tasks/${taskId}/qa-start`)).body.error.code).toBe('qa_estimate_missing');
      expect((await rahim.patch(`/tasks/tasks/${taskId}/qa-estimate`, { qaEstimatedHours: 2 })).status).toBe(200);
      expect((await mehedi.post(`/tasks/tasks/${taskId}/qa-start`)).status).toBe(200);
    });

    it("won't give the task to its QA person while their round is open or its result stands", async () => {
      const { rahim, taskId } = await setUp();
      await workThrough(taskId);
      await rahim.post(`/tasks/tasks/${taskId}/qa-handover`, { qaId: ID.MEHEDI, qaEstimatedHours: 2 });
      const duringQa = await rahim.patch(`/tasks/tasks/${taskId}`, { assignedDevId: ID.MEHEDI });
      expect(duringQa.status).toBe(422);
      expect(duringQa.body.error.fields[0].path).toBe('assignedDevId');

      const mehedi = await as('mehedi');
      await mehedi.post(`/tasks/tasks/${taskId}/qa-start`);
      await mehedi.post(`/tasks/tasks/${taskId}/qa-complete`, { result: 'pass' });
      expect((await rahim.patch(`/tasks/tasks/${taskId}`, { assignedDevId: ID.MEHEDI })).status).toBe(422);
      expect((await Task.findById(taskId).lean())?.assignedDevId).toBe(ID.ARIF);
    });

    it('clears an earlier estimate when a task goes to QA again without one', async () => {
      const { rahim, taskId } = await setUp();
      await workThrough(taskId);
      await rahim.post(`/tasks/tasks/${taskId}/qa-handover`, { qaId: ID.MEHEDI, qaEstimatedHours: 2 });
      const again = await rahim.post(`/tasks/tasks/${taskId}/qa-handover`, { qaId: ID.MEHEDI });
      expect(again.status).toBe(409);
    });
  });

  describe('flags, billing and actual hours', () => {
    it('flags a task with a note at any status, done included, and clears it', async () => {
      const { rahim, taskId } = await setUp();
      await workThrough(taskId);
      await rahim.post(`/tasks/tasks/${taskId}/approve`, { hours: { basis: 'estimated' } });
      expect((await rahim.patch(`/tasks/tasks/${taskId}/flag`, { flagged: true, flagNote: 'Check the hours' })).body).toMatchObject({ flagged: true, flagNote: 'Check the hours' });
      expect((await rahim.get('/tasks/tasks?flagged=true')).body.total).toBe(1);
      const cleared = (await rahim.patch(`/tasks/tasks/${taskId}/flag`, { flagged: false })).body;
      expect(cleared.flagged).toBe(false);
      expect(cleared).not.toHaveProperty('flagNote');
    });

    it('lets field access give flagging alone, as for HR, without other edits', async () => {
      const { taskId } = await setUp();
      await AccessProfile.create({
        _id: 'ap_hr_tasks',
        name: 'HR on tasks',
        grants: { tasks: { task: { actions: ['read', 'update'], scope: 'all', fieldAccess: { flagged: 'edit', flagNote: 'edit', title: 'read', estimatedHours: 'read', billable: 'read', actualHours: 'read' } } } },
      });
      await User.updateOne({ _id: ID.KAMRUL }, { $set: { profileId: 'ap_hr_tasks' } });
      const kamrul = await as('kamrul');
      expect((await kamrul.patch(`/tasks/tasks/${taskId}/flag`, { flagged: true, flagNote: 'Too long' })).status).toBe(200);
      expect((await kamrul.patch(`/tasks/tasks/${taskId}`, { title: 'Renamed' })).body.error.code).toBe('field_not_editable');
      expect((await kamrul.patch(`/tasks/tasks/${taskId}/billable`, { billable: false })).body.error.code).toBe('field_not_editable');
    });

    it('marks hours as not billable, but not on a cancelled task', async () => {
      const { rahim, taskId } = await setUp();
      expect((await rahim.patch(`/tasks/tasks/${taskId}/billable`, { billable: false })).body.billable).toBe(false);
      await rahim.post(`/tasks/tasks/${taskId}/cancel`);
      expect((await rahim.patch(`/tasks/tasks/${taskId}/billable`, { billable: true })).body.error.code).toBe('invalid_status');
    });

    it('corrects actual hours once there are some', async () => {
      const { rahim, taskId } = await setUp();
      expect((await rahim.patch(`/tasks/tasks/${taskId}/actual-hours`, { actualHours: 3 })).body.error.code).toBe('no_actual_hours');
      await workThrough(taskId);
      expect((await rahim.patch(`/tasks/tasks/${taskId}/actual-hours`, { actualHours: 7.5 })).body.actualHours).toBe(7.5);
      expect((await rahim.get(`/tasks/tasks/${taskId}/history`)).body.entries[0].changes).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: 'actualHours', to: 7.5 })]),
      );
    });

    it('keeps the developer from changing these', async () => {
      const { taskId } = await setUp();
      expect((await (await as('arif')).patch(`/tasks/tasks/${taskId}/flag`, { flagged: true })).status).toBe(403);
    });
  });

  describe('finding, summing and exporting', () => {
    async function threeTasks() {
      const { rahim, projectId, taskId } = await setUp({ estimatedHours: 8 });
      await rahim.post('/tasks/tasks', { projectId, title: 'Fix login', assignedDevId: ID.MEHEDI, estimatedHours: 2 });
      await rahim.post('/tasks/tasks', { projectId, title: '=SUM(A1) docs', assignedDevId: ID.ARIF, estimatedHours: 5 });
      await workThrough(taskId);
      return { rahim, projectId, taskId };
    }

    it('searches by title or task number', async () => {
      const { rahim, taskId } = await threeTasks();
      const number = (await rahim.get(`/tasks/tasks/${taskId}`)).body.number as string;
      expect((await rahim.get('/tasks/tasks?search=login')).body.tasks.map((task: { title: string }) => task.title)).toEqual(['Fix login']);
      expect((await rahim.get(`/tasks/tasks?search=${number}`)).body.tasks[0].id).toBe(taskId);
      expect((await rahim.get(`/tasks/tasks?search=${number.slice(2)}`)).body.tasks[0].id).toBe(taskId);
      expect((await rahim.get('/tasks/tasks/search?search=fix')).body.tasks).toEqual([expect.objectContaining({ title: 'Fix login', projectName: 'Payroll revamp' })]);
    });

    it('keeps a hidden title out of the picker search too', async () => {
      const { rahim, taskId } = await threeTasks();
      const number = (await rahim.get(`/tasks/tasks/${taskId}`)).body.number as string;
      await AccessProfile.updateOne({ _id: 'ap_engineering_lead' }, { $set: { 'grants.tasks.task.fieldAccess.title': 'hidden' } });
      const [found] = (await rahim.get(`/tasks/tasks/search?search=${number}`)).body.tasks;
      expect(found).toMatchObject({ number: expect.stringMatching(/^T-/), projectName: 'Payroll revamp' });
      expect(found).not.toHaveProperty('title');
    });

    it('sorts by estimate and by variance', async () => {
      const { rahim } = await threeTasks();
      const byEstimate = (await rahim.get('/tasks/tasks?sortBy=estimatedHours&sortDirection=asc')).body.tasks.map((task: { estimatedHours: number }) => task.estimatedHours);
      expect(byEstimate).toEqual([2, 5, 8]);
      const byVariance = (await rahim.get('/tasks/tasks?sortBy=variance&sortDirection=asc')).body.tasks;
      // Only the finished task has a variance: it was done in seconds against 8 hours planned.
      expect(byVariance.at(-1).title).toBe('Build the export');
    });

    it('filters by assignee, TL, completion date and projects the caller leads', async () => {
      const { rahim } = await threeTasks();
      expect((await rahim.get(`/tasks/tasks?assignedDevId=${ID.MEHEDI}`)).body.total).toBe(1);
      expect((await rahim.get(`/tasks/tasks?tlId=${ID.RAHIM}`)).body.total).toBe(3);
      const today = new Date().toISOString().slice(0, 10);
      expect((await rahim.get(`/tasks/tasks?completedFrom=${today}&completedTo=${today}`)).body.total).toBe(1);
      expect((await rahim.get('/tasks/tasks?mine=true')).body.total).toBe(3);
      expect((await (await as('arif')).get('/tasks/tasks?mine=true')).body.total).toBe(0);
    });

    it('counts tasks saved before flags and billing existed as not flagged and billable', async () => {
      const { rahim } = await threeTasks();
      await Task.updateMany({}, { $unset: { flagged: 1, billable: 1 } });
      expect((await rahim.get('/tasks/tasks?billable=true')).body.total).toBe(3);
      expect((await rahim.get('/tasks/tasks?flagged=false')).body.total).toBe(3);
      expect((await rahim.get('/tasks/tasks?billable=false')).body.total).toBe(0);
      expect((await rahim.get('/tasks/tasks?flagged=true')).body.total).toBe(0);
    });

    it('leaves the variance out of the sums when actual hours are hidden', async () => {
      const { rahim } = await threeTasks();
      expect((await rahim.get('/tasks/tasks/summary')).body).toHaveProperty('varianceHours');
      await AccessProfile.updateOne({ _id: 'ap_engineering_lead' }, { $set: { 'grants.tasks.task.fieldAccess.actualHours': 'hidden' } });
      const { body } = await rahim.get('/tasks/tasks/summary');
      expect(body).toMatchObject({ taskCount: 3, estimatedHours: 15 });
      expect(body).not.toHaveProperty('actualHours');
      expect(body).not.toHaveProperty('varianceHours');
    });

    it('sums the filtered tasks', async () => {
      const { rahim } = await threeTasks();
      expect((await rahim.get('/tasks/tasks/summary')).body).toMatchObject({ taskCount: 3, estimatedHours: 15, pointValue: 750 });
      expect((await rahim.get(`/tasks/tasks/summary?assignedDevId=${ID.MEHEDI}`)).body).toMatchObject({ taskCount: 1, estimatedHours: 2 });
    });

    it('exports CSV within the scope, with formulas made harmless', async () => {
      const { rahim } = await threeTasks();
      const csv = await rahim.get('/tasks/tasks/export');
      expect(csv.headers['content-type']).toContain('text/csv');
      const lines = csv.text.split('\r\n');
      expect(lines[0]).toBe('number,title,projectName,status,assignedDevName,tlName,estimatedHours,actualHours,approvedHours,pointValue,billable,flagged,dueDate,completedAt');
      expect(lines).toHaveLength(4);
      expect(csv.text).toContain("'=SUM(A1) docs");
      expect(csv.text).toContain('Arif Chowdhury');

      const arifCsv = (await (await as('mehedi')).get('/tasks/tasks/export')).text.split('\r\n');
      expect(arifCsv).toHaveLength(2);
    });

    it.each(['sortBy=points', 'sortDirection=up', 'completedFrom=yesterday', 'flagged=maybe'])('refuses the query %s', async (query) => {
      expect((await (await as('rahim')).get(`/tasks/tasks?${query}`)).status).toBe(422);
    });
  });
});
