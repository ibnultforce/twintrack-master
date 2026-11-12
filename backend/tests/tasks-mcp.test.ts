import type { Application } from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { AccessProfile } from '../src/modules/master/models/accessProfile.js';
import { seedDatabase } from '../src/seed/seedDatabase.js';
import { useTestDatabase } from './helpers/database.js';
import { requestsAs, signIn } from './helpers/signedIn.js';
import { readSeedFiles } from './helpers/testAccess.js';
import { createTestConfig } from './helpers/testConfig.js';

const PASSWORD = 'correct-password';
const ID = { MEHEDI: 'u_09', SUMAIYA: 'u_10' };

describe('Tasks MCP tools', () => {
  useTestDatabase();

  let app: Application;
  const as = async (name: string) => requestsAs(app, await signIn(app, `${name}@twintrack.test`, PASSWORD));
  const tokenFor = async (name: string) => (await (await as(name)).post('/me/api-tokens', { name: 'Claude Code' })).body.token as string;

  /** Calls one tool and returns its text: the JSON data, or the refusal the model reads. */
  async function callTool(token: string, name: string, args: object = {}) {
    const response = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${token}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    const result = response.body.result as { isError?: boolean; content: { text: string }[] };
    const text = result.content[0]!.text;
    return { isError: Boolean(result.isError), text, data: result.isError ? undefined : JSON.parse(text) };
  }

  beforeAll(() => {
    app = createApp(createTestConfig());
  });

  beforeEach(async () => {
    await seedDatabase({ files: readSeedFiles(), password: PASSWORD, nodeEnv: 'test' });
    const rahim = await as('rahim');
    await rahim.post('/tasks/projects', { name: 'Payroll revamp', memberIds: [ID.MEHEDI, ID.SUMAIYA] });
    await rahim.post('/tasks/projects', { name: 'Payroll reports', memberIds: [ID.MEHEDI] });
  });

  it('lists the tools from Master and Tasks together', async () => {
    const token = await tokenFor('rahim');
    const response = await request(app).post('/mcp').set('Authorization', `Bearer ${token}`).set('Accept', 'application/json, text/event-stream').send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const names = response.body.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toEqual(expect.arrayContaining(['whoami', 'list_projects', 'list_project_members', 'get_workload', 'list_tasks', 'get_task', 'create_task', 'bulk_create_tasks', 'update_task', 'reassign_task', 'hand_over_to_qa']));
  });

  it('creates a task from a project and a person named in words', async () => {
    const token = await tokenFor('rahim');
    const created = await callTool(token, 'create_task', { project: 'payroll revamp', assignee: 'mehedi', title: 'Fix rounding', estimatedHours: 3 });
    expect(created.data).toMatchObject({ title: 'Fix rounding', assignedDevId: ID.MEHEDI, pointValue: 150, number: expect.stringMatching(/^T-/) });

    const fetched = await callTool(token, 'get_task', { number: created.data.number });
    expect(fetched.data).toMatchObject({ title: 'Fix rounding', comments: [] });
  });

  it('asks which one when a name matches several, and lists options when it matches none', async () => {
    const token = await tokenFor('rahim');
    const ambiguous = await callTool(token, 'create_task', { project: 'payroll', assignee: 'mehedi', title: 'X', estimatedHours: 1 });
    expect(ambiguous).toMatchObject({ isError: true, text: expect.stringContaining('matches several projects: Payroll reports, Payroll revamp') });
    const unknown = await callTool(token, 'create_task', { project: 'payroll revamp', assignee: 'karim', title: 'X', estimatedHours: 1 });
    expect(unknown.text).toContain('No project member matches "karim"');
  });

  it('creates several tasks, reporting the one that failed without stopping the rest', async () => {
    const token = await tokenFor('rahim');
    const { data } = await callTool(token, 'bulk_create_tasks', {
      tasks: [
        { project: 'Payroll revamp', assignee: 'Mehedi', title: 'One', estimatedHours: 1 },
        { project: 'Payroll revamp', assignee: 'Mehedi', title: 'Two' },
        { project: 'Payroll revamp', assignee: 'Sumaiya', title: 'Three', estimatedHours: 2 },
      ],
    });
    expect(data).toEqual([
      expect.objectContaining({ title: 'One', created: true }),
      expect.objectContaining({ title: 'Two', created: false, reason: expect.stringContaining('estimatedHours') }),
      expect.objectContaining({ title: 'Three', created: true }),
    ]);
  });

  it('shows workload, reassigns and hands over to QA', async () => {
    const token = await tokenFor('rahim');
    const { data: task } = await callTool(token, 'create_task', { project: 'Payroll revamp', assignee: 'Mehedi', title: 'Export', estimatedHours: 5 });
    const workload = (await callTool(token, 'get_workload', { project: 'Payroll revamp' })).data;
    expect(workload).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Mehedi Hasan', openTasks: 1, openEstimatedHours: 5 })]));

    expect((await callTool(token, 'reassign_task', { number: task.number, assignee: 'Sumaiya' })).data.assignedDevId).toBe(ID.SUMAIYA);

    const sumaiya = await as('sumaiya');
    await sumaiya.post(`/tasks/tasks/${task.id}/start`);
    await sumaiya.post(`/tasks/tasks/${task.id}/complete`);
    expect((await callTool(token, 'hand_over_to_qa', { number: task.number, qa: 'Mehedi', qaEstimatedHours: 1 })).data).toMatchObject({ status: 'qa_todo', qaId: ID.MEHEDI });
  });

  it('counts workload only in tasks the person can see, and needs task.read', async () => {
    const rahim = await as('rahim');
    await rahim.post('/tasks/tasks', { projectId: (await rahim.get('/tasks/projects')).body.projects.find((project: { name: string }) => project.name === 'Payroll revamp').id, title: 'Export', assignedDevId: ID.SUMAIYA, estimatedHours: 5 });
    // A project Mehedi isn't on: Sumaiya's work there is beyond his own scope.
    const portal = (await rahim.post('/tasks/projects', { name: 'Client portal', memberIds: [ID.SUMAIYA] })).body;
    await rahim.post('/tasks/tasks', { projectId: portal.id, title: 'Hidden', assignedDevId: ID.SUMAIYA, estimatedHours: 7 });

    const leadView = (await callTool(await tokenFor('rahim'), 'get_workload', { project: 'Payroll revamp' })).data;
    expect(leadView).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Sumaiya Islam', openTasks: 2, openEstimatedHours: 12 })]));

    const mehediToken = await tokenFor('mehedi');
    const mehediView = (await callTool(mehediToken, 'get_workload', { project: 'Payroll revamp' })).data;
    expect(mehediView).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Sumaiya Islam', openTasks: 0 })]));

    await AccessProfile.updateOne({ _id: 'ap_developer' }, { $unset: { 'grants.tasks.task': 1 } });
    expect((await callTool(mehediToken, 'get_workload', { project: 'Payroll revamp' })).text).toBe('You need task.read in Tasks to do this.');
  });

  it("keeps each tool to the person's own access", async () => {
    // Mehedi reads only his own tasks and can't create any.
    const token = await tokenFor('mehedi');
    expect((await callTool(token, 'create_task', { project: 'Payroll revamp', assignee: 'Mehedi', title: 'Mine', estimatedHours: 1 })).text).toBe('You need task.create in Tasks to do this.');
    expect((await callTool(token, 'list_tasks', {})).data.total).toBe(0);
    expect((await callTool(token, 'get_task', { number: 'T-99999' })).text).toBe('No task T-99999.');
  });
});
