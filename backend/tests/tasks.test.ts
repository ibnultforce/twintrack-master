import { readFileSync } from 'node:fs';
import type { Application } from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolveDependencies } from '../src/appDependencies.js';
import { createApp } from '../src/app.js';
import { AuditLog } from '../src/modules/master/models/auditLog.js';
import { User } from '../src/modules/master/models/user.js';
import { Task } from '../src/modules/tasks/models/task.js';
import { createTasksRoutes } from '../src/modules/tasks/tasks.routes.js';
import { formatTaskNumber, secondsWorked } from '../src/modules/tasks/task/taskLifecycle.js';
import { seedDatabase } from '../src/seed/seedDatabase.js';
import { useTestDatabase } from './helpers/database.js';
import { requestsAs, signIn } from './helpers/signedIn.js';
import { readSeedFiles } from './helpers/testAccess.js';
import { createTestConfig } from './helpers/testConfig.js';

const PASSWORD = 'correct-password';
// Rahim leads the engineering team. Arif, Mehedi and Sumaiya are developers on it, and Karim has no Tasks access.
const ID = { FARHANA: 'u_01', RAHIM: 'u_04', ARIF: 'u_07', KARIM: 'u_08', MEHEDI: 'u_09', SUMAIYA: 'u_10' };

describe('Tasks module', () => {
  useTestDatabase();

  let app: Application;
  const as = async (name: string) => requestsAs(app, await signIn(app, `${name}@twintrack.test`, PASSWORD));

  beforeAll(() => {
    app = createApp(createTestConfig());
  });

  beforeEach(async () => {
    await seedDatabase({ files: readSeedFiles(), password: PASSWORD, nodeEnv: 'test' });
  });

  /** A project Rahim leads, with Arif and Mehedi on it, and one task for Arif. */
  async function setUpProjectWithTask(task: Record<string, unknown> = {}) {
    const rahim = await as('rahim');
    const project = await rahim.post('/tasks/projects', { name: 'Payroll revamp', memberIds: [ID.ARIF, ID.MEHEDI] });
    expect(project.status).toBe(201);
    const created = await rahim.post('/tasks/tasks', { projectId: project.body.id, title: 'Build the export', assignedDevId: ID.ARIF, estimatedHours: 8, ...task });
    expect(created.status).toBe(201);
    return { rahim, projectId: project.body.id as string, taskId: created.body.id as string, task: created.body };
  }

  /** Takes a task from todo to pending approval, the way its assignee would. */
  async function workThrough(taskId: string) {
    const arif = await as('arif');
    expect((await arif.post(`/tasks/tasks/${taskId}/start`)).status).toBe(200);
    expect((await arif.post(`/tasks/tasks/${taskId}/complete`)).status).toBe(200);
    return arif;
  }

  it('builds what the Tasks manifest says is built, with the same permissions', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../manifests/tasks.manifest.json', import.meta.url), 'utf8')) as {
      module: { baseUrl: string };
      routes: { method: string; path: string; access: string; permission?: string; planned?: boolean }[];
    };
    const describeRoute = (route: { method: string; path: string; access: string; permission?: string }) => `${route.method} ${route.path} ${route.access} ${route.permission}`;
    const built = manifest.routes.filter((route) => !route.planned).map((route) => describeRoute({ ...route, path: `${manifest.module.baseUrl}${route.path}` }));
    expect(built.sort()).toEqual(createTasksRoutes(createTestConfig(), resolveDependencies(createTestConfig())).map(describeRoute).sort());
  });

  describe('lifecycle rules', () => {
    it('shows task numbers with five digits', () => {
      expect(formatTaskNumber(102)).toBe('T-00102');
    });

    it('counts banked seconds plus the time since the timer was resumed', () => {
      const resumedAt = new Date('2026-01-01T10:00:00Z');
      expect(secondsWorked({ accumulatedSeconds: 60, resumedAt }, new Date('2026-01-01T10:30:00Z'))).toBe(60 + 1800);
      expect(secondsWorked({ accumulatedSeconds: 60 }, new Date())).toBe(60);
    });
  });

  describe('projects', () => {
    it('lets a lead create one they lead, with the members they choose', async () => {
      const response = await (await as('rahim')).post('/tasks/projects', { name: 'Payroll revamp', memberIds: [ID.ARIF, ID.ARIF, ID.RAHIM] });
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ leadId: ID.RAHIM, status: 'active', members: [{ id: ID.ARIF, name: 'Arif Chowdhury' }] });
    });

    it('refuses members outside the lead\'s team scope', async () => {
      const response = await (await as('rahim')).post('/tasks/projects', { name: 'Finance', leadId: 'u_05' });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('out_of_scope');
    });

    it('shows a developer only the projects they are on', async () => {
      await setUpProjectWithTask();
      expect((await (await as('arif')).get('/tasks/projects')).body.total).toBe(1);
      expect((await (await as('sumaiya')).get('/tasks/projects')).body.total).toBe(0);
    });

    it('refuses someone with no Tasks access', async () => {
      const response = await (await as('karim')).get('/tasks/projects');
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('forbidden');
      expect((await request(app).get('/tasks/projects')).status).toBe(401);
    });

    it('keeps a member who still has open tasks in the project', async () => {
      const { rahim, projectId } = await setUpProjectWithTask();
      const response = await rahim.put(`/tasks/projects/${projectId}/members`, { memberIds: [ID.MEHEDI] });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('member_has_open_tasks');
      expect((await rahim.put(`/tasks/projects/${projectId}/members`, { memberIds: [ID.ARIF, ID.MEHEDI, ID.SUMAIYA] })).status).toBe(200);
    });

    it("keeps the lead, who leaves the project when replaced, while they still have open tasks in it", async () => {
      const { rahim, projectId } = await setUpProjectWithTask();
      await rahim.post('/tasks/tasks', { projectId, title: 'Review', assignedDevId: ID.RAHIM, tlId: ID.RAHIM, estimatedHours: 1 });
      const response = await rahim.patch(`/tasks/projects/${projectId}`, { leadId: ID.ARIF });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('member_has_open_tasks');
      expect((await rahim.get(`/tasks/projects/${projectId}`)).body.leadId).toBe(ID.RAHIM);
    });

    it('checks the reach before saying anything about open tasks', async () => {
      const { projectId } = await setUpProjectWithTask();
      await User.updateOne({ _id: 'u_05' }, { $set: { profileId: 'ap_engineering_lead' } });
      const outsider = await as('rumana');
      expect((await outsider.put(`/tasks/projects/${projectId}/members`, { memberIds: [] })).body.error.code).toBe('out_of_scope');
    });
  });

  describe('creating and reading tasks', () => {
    it('numbers each task and makes the creator its TL', async () => {
      const { task } = await setUpProjectWithTask();
      expect(task).toMatchObject({ number: expect.stringMatching(/^T-\d{5}$/), status: 'todo', tlId: ID.RAHIM, assignedDevId: ID.ARIF, projectName: 'Payroll revamp' });
    });

    it('only assigns tasks to the project lead or a member', async () => {
      const { rahim, projectId } = await setUpProjectWithTask();
      const response = await rahim.post('/tasks/tasks', { projectId, title: 'Not on it', assignedDevId: ID.SUMAIYA, estimatedHours: 2 });
      expect(response.status).toBe(422);
      expect(response.body.error.fields[0].path).toBe('assignedDevId');
    });

    it('shows a developer only the tasks they are linked to', async () => {
      await setUpProjectWithTask();
      expect((await (await as('arif')).get('/tasks/tasks')).body.total).toBe(1);
      expect((await (await as('sumaiya')).get('/tasks/tasks')).body.total).toBe(0);
      expect((await (await as('rahim')).get('/tasks/tasks?status=todo')).body.total).toBe(1);
      expect((await (await as('rahim')).get('/tasks/tasks?status=done')).body.total).toBe(0);
    });

    it('lists overdue tasks', async () => {
      // A new task can't be due in the past, so this one becomes overdue the way real ones do: its date passes.
      const { rahim, taskId } = await setUpProjectWithTask();
      await Task.updateOne({ _id: taskId }, { $set: { dueDate: new Date('2020-01-01') } });
      expect((await rahim.get('/tasks/tasks?overdue=true')).body.total).toBe(1);
    });

    it('refuses a task outside someone\'s reach', async () => {
      const { taskId } = await setUpProjectWithTask();
      const response = await (await as('sumaiya')).get(`/tasks/tasks/${taskId}`);
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('out_of_scope');
    });
  });

  describe('working on a task', () => {
    it('runs from start through QA to approval, and logs every step', async () => {
      const { rahim, taskId } = await setUpProjectWithTask();
      const arif = await as('arif');

      expect((await arif.post(`/tasks/tasks/${taskId}/start`)).body).toMatchObject({ status: 'in_progress', paused: false });
      expect((await arif.post(`/tasks/tasks/${taskId}/pause`)).body).toMatchObject({ status: 'in_progress', paused: true });
      expect((await arif.post(`/tasks/tasks/${taskId}/start`)).body.paused).toBe(false);
      const completed = await arif.post(`/tasks/tasks/${taskId}/complete`);
      expect(completed.body).toMatchObject({ status: 'pending_approval', actualHours: 0 });

      const handover = await rahim.post(`/tasks/tasks/${taskId}/qa-handover`, { qaId: ID.MEHEDI, qaEstimatedHours: 2 });
      expect(handover.body).toMatchObject({ status: 'qa_todo', qaId: ID.MEHEDI, qaEstimatedHours: 2 });

      const mehedi = await as('mehedi');
      expect((await mehedi.post(`/tasks/tasks/${taskId}/qa-start`)).body.status).toBe('qa_in_progress');
      expect((await mehedi.post(`/tasks/tasks/${taskId}/qa-complete`, { result: 'pass' })).body).toMatchObject({ status: 'pending_approval', qaResult: 'pass' });

      const approved = await rahim.post(`/tasks/tasks/${taskId}/approve`, { hours: { basis: 'estimated' }, qaHours: { basis: 'custom', customHours: 1.5 } });
      expect(approved.status).toBe(200);
      expect(approved.body).toMatchObject({ status: 'done', approvedHours: 8, qaApprovedHours: 1.5, approvedBy: ID.RAHIM });

      const statuses = (await rahim.get(`/tasks/tasks/${taskId}/history`)).body.entries
        .flatMap((entry: { changes: { field: string; to?: string }[] }) => entry.changes.filter((change) => change.field === 'status').map((change) => change.to));
      expect(statuses.reverse()).toEqual(['todo', 'in_progress', 'pending_approval', 'qa_todo', 'qa_in_progress', 'pending_approval', 'done']);
      expect(await AuditLog.countDocuments({ action: 'task.approved', targetId: taskId })).toBe(1);
    });

    it('lets only the assignee run the timer', async () => {
      const { rahim, taskId } = await setUpProjectWithTask();
      const response = await rahim.post(`/tasks/tasks/${taskId}/start`);
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('not_assignee');
    });

    it('refuses a step the status does not allow', async () => {
      const { rahim, taskId } = await setUpProjectWithTask();
      const response = await rahim.post(`/tasks/tasks/${taskId}/approve`, { hours: { basis: 'estimated' } });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('invalid_status');
      expect((await (await as('arif')).post(`/tasks/tasks/${taskId}/pause`)).body.error.code).toBe('invalid_status');
    });

    it('lets only the QA person run QA, and never the assignee', async () => {
      const { rahim, taskId } = await setUpProjectWithTask();
      await workThrough(taskId);
      expect((await rahim.post(`/tasks/tasks/${taskId}/qa-handover`, { qaId: ID.ARIF })).body.error.fields[0].path).toBe('qaId');
      await rahim.post(`/tasks/tasks/${taskId}/qa-handover`, { qaId: ID.MEHEDI });
      expect((await (await as('arif')).post(`/tasks/tasks/${taskId}/qa-start`)).body.error.code).toBe('not_qa');
    });

    it('hides QA hours from someone without access to those fields, but shows the QA result', async () => {
      const { rahim, taskId } = await setUpProjectWithTask();
      const arif = await workThrough(taskId);
      await rahim.post(`/tasks/tasks/${taskId}/qa-handover`, { qaId: ID.MEHEDI, qaEstimatedHours: 2 });
      const mehedi = await as('mehedi');
      await mehedi.post(`/tasks/tasks/${taskId}/qa-start`);
      await mehedi.post(`/tasks/tasks/${taskId}/qa-complete`, { result: 'fail' });

      const seen = (await arif.get(`/tasks/tasks/${taskId}`)).body;
      expect(seen.qaResult).toBe('fail');
      expect(seen).not.toHaveProperty('qaEstimatedHours');
      expect(seen).not.toHaveProperty('qaActualHours');
      const history = JSON.stringify((await arif.get(`/tasks/tasks/${taskId}/history`)).body);
      expect(history).not.toContain('qaEstimatedHours');
    });

    it('needs QA hours when approving a task that went through QA', async () => {
      const { rahim, taskId } = await setUpProjectWithTask();
      await workThrough(taskId);
      await rahim.post(`/tasks/tasks/${taskId}/qa-handover`, { qaId: ID.MEHEDI, qaEstimatedHours: 2 });
      const mehedi = await as('mehedi');
      await mehedi.post(`/tasks/tasks/${taskId}/qa-start`);
      await mehedi.post(`/tasks/tasks/${taskId}/qa-complete`, { result: 'pass' });
      const response = await rahim.post(`/tasks/tasks/${taskId}/approve`, { hours: { basis: 'actual' } });
      expect(response.status).toBe(422);
      expect(response.body.error.fields[0].path).toBe('qaHours');
    });

    it('keeps custom hours within the larger of estimated and actual hours', async () => {
      const { rahim, taskId } = await setUpProjectWithTask();
      await workThrough(taskId);
      const tooMany = await rahim.post(`/tasks/tasks/${taskId}/approve`, { hours: { basis: 'custom', customHours: 9 } });
      expect(tooMany.status).toBe(422);
      expect(tooMany.body.error.fields[0].path).toBe('hours.customHours');
      expect((await rahim.post(`/tasks/tasks/${taskId}/approve`, { hours: { basis: 'custom', customHours: 6 } })).body.approvedHours).toBe(6);
    });

    it('never lets someone approve their own work, whatever their permissions', async () => {
      const { rahim, projectId } = await setUpProjectWithTask();
      const own = await rahim.post('/tasks/tasks', { projectId, title: 'My own', assignedDevId: ID.RAHIM, estimatedHours: 1 });
      await rahim.post(`/tasks/tasks/${own.body.id}/start`);
      await rahim.post(`/tasks/tasks/${own.body.id}/complete`);
      const response = await rahim.post(`/tasks/tasks/${own.body.id}/approve`, { hours: { basis: 'estimated' } });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('own_work');
    });

    it('refuses approval to someone without task.approve', async () => {
      const { taskId } = await setUpProjectWithTask();
      await workThrough(taskId);
      expect((await (await as('mehedi')).post(`/tasks/tasks/${taskId}/approve`, { hours: { basis: 'estimated' } })).body.error.code).toBe('forbidden');
    });

    it('reverts a done task with a reason, which is saved as a comment, and clears its approval', async () => {
      const { rahim, taskId } = await setUpProjectWithTask();
      await workThrough(taskId);
      await rahim.post(`/tasks/tasks/${taskId}/approve`, { hours: { basis: 'estimated' } });

      expect((await rahim.post(`/tasks/tasks/${taskId}/revert`, {})).status).toBe(422);
      const reverted = await rahim.post(`/tasks/tasks/${taskId}/revert`, { comment: 'The export drops the last row.' });
      expect(reverted.body).toMatchObject({ status: 'reverted', revertCount: 1 });
      expect(reverted.body.approvedHours).toBeUndefined();

      const comments = (await (await as('arif')).get(`/tasks/tasks/${taskId}/comments`)).body;
      expect(comments.comments).toEqual([expect.objectContaining({ authorId: ID.RAHIM, body: 'The export drops the last row.' })]);
      expect((await (await as('arif')).post(`/tasks/tasks/${taskId}/start`)).body.status).toBe('in_progress');
    });

    it('cancels an open task, but never a done one', async () => {
      const { rahim, taskId } = await setUpProjectWithTask();
      expect((await (await as('arif')).post(`/tasks/tasks/${taskId}/cancel`)).body.error.code).toBe('forbidden');
      expect((await rahim.post(`/tasks/tasks/${taskId}/cancel`)).body).toMatchObject({ status: 'cancelled', cancelledBy: ID.RAHIM });

      const { taskId: doneId } = await setUpProjectWithTask();
      await workThrough(doneId);
      await rahim.post(`/tasks/tasks/${doneId}/approve`, { hours: { basis: 'estimated' } });
      expect((await rahim.post(`/tasks/tasks/${doneId}/cancel`)).body.error.code).toBe('invalid_status');
    });

    it('refuses an edit made from an old copy', async () => {
      const { rahim, taskId, task } = await setUpProjectWithTask();
      expect((await rahim.patch(`/tasks/tasks/${taskId}`, { estimatedHours: 10, version: task.version })).status).toBe(200);
      expect((await rahim.patch(`/tasks/tasks/${taskId}`, { estimatedHours: 12, version: task.version })).body.error.code).toBe('version_conflict');
    });

    it('does not move a task to someone else while its timer runs', async () => {
      const { rahim, taskId } = await setUpProjectWithTask();
      await (await as('arif')).post(`/tasks/tasks/${taskId}/start`);
      expect((await rahim.patch(`/tasks/tasks/${taskId}`, { assignedDevId: ID.MEHEDI })).body.error.code).toBe('timer_running');
    });
  });

  describe('comments and references', () => {
    it('lets anyone who reaches a task comment on it', async () => {
      const { taskId } = await setUpProjectWithTask();
      const response = await (await as('arif')).post(`/tasks/tasks/${taskId}/comments`, { body: 'Started on the CSV part.' });
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ authorName: 'Arif Chowdhury', body: 'Started on the CSV part.' });
      expect((await (await as('sumaiya')).post(`/tasks/tasks/${taskId}/comments`, { body: 'Hi' })).body.error.code).toBe('out_of_scope');
    });

    it('links tasks both ways, and refuses a link to itself or a missing task', async () => {
      const { rahim, projectId, taskId } = await setUpProjectWithTask();
      const other = await rahim.post('/tasks/tasks', { projectId, title: 'Fix the import', assignedDevId: ID.MEHEDI, estimatedHours: 3 });

      expect((await rahim.put(`/tasks/tasks/${taskId}/references`, { taskIds: [taskId, 't_missing'] })).body.error.fields).toHaveLength(2);
      expect((await rahim.put(`/tasks/tasks/${taskId}/references`, { taskIds: [other.body.id] })).status).toBe(200);
      expect((await rahim.get(`/tasks/tasks/${taskId}`)).body.references).toEqual([expect.objectContaining({ id: other.body.id, number: other.body.number })]);
      expect((await rahim.get(`/tasks/tasks/${other.body.id}`)).body.referencedBy).toEqual([expect.objectContaining({ id: taskId })]);
    });
  });
});
