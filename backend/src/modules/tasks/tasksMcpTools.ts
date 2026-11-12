import { z } from 'zod';
import { ApiError } from '../../lib/errors.js';
import { buildActorIn } from '../master/access/access.service.js';
import type { Actor } from '../master/access/caller.js';
import { toolError, toolResult, type McpCaller, type McpToolProvider } from '../master/mcp/mcpTools.js';
import type { Scope } from '../master/moduleRegistry/manifest.js';
import { TASK_KINDS, TASK_STATUSES } from './models/task.js';
import { getProject, listProjects } from './project/project.service.js';
import { findTaskByNumber, parseTaskNumber } from './task/task.repository.js';
import { createTask, getOpenWork, getTask, handOverToQa, listTaskComments, listTasks, updateTask } from './task/task.service.js';
import { TASKS_MODULE_KEY } from './tasksModule.js';

const MAX_TEXT = 10_000;
const MAX_NAME = 200;
const MAX_BULK_TASKS = 20;
const LIST_PAGE_SIZE = 25;
const OPTIONS_SHOWN = 25;

const instructionsNote = 'Projects and people are named, not given by id. Tasks are named by number, such as T-00102.';

/** The actor and scope a route would have for this permission, or a refusal the model can read. */
async function actorFor(caller: McpCaller, permission: string): Promise<{ actor: Actor; scope: Scope }> {
  const actor = await buildActorIn(caller, TASKS_MODULE_KEY);
  const scope = actor?.permissions[permission];
  if (!actor || !scope) throw new ApiError(403, 'forbidden', `You need ${permission} in Tasks to do this.`);
  return { actor, scope };
}

/** A refusal as the model reads it, naming each field that was wrong. */
function describeRefusal(error: ApiError): string {
  const fields = error.fields?.map((field) => `${field.path} ${field.message}`).join('; ');
  return fields ? `${error.message} ${fields}.` : error.message;
}

async function answer(work: () => Promise<unknown>) {
  try {
    return toolResult(await work());
  } catch (error) {
    if (error instanceof ApiError) return toolError(describeRefusal(error));
    throw error;
  }
}

const normalize = (text: string) => text.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Picks the one item a name means: an exact match, otherwise a single partial match. Anything ambiguous or unknown is
 * refused with the real options, so the model asks the person instead of guessing.
 */
function pickOne<Item>(items: Item[], name: string, labelOf: (item: Item) => string, kind: string): Item {
  const wanted = normalize(name);
  const exact = items.filter((item) => normalize(labelOf(item)) === wanted);
  const candidates = exact.length > 0 ? exact : items.filter((item) => normalize(labelOf(item)).includes(wanted));
  if (candidates.length === 1) return candidates[0]!;
  const options = (candidates.length > 1 ? candidates : items).map(labelOf).slice(0, OPTIONS_SHOWN).join(', ');
  if (candidates.length > 1) throw new ApiError(422, 'ambiguous_name', `"${name}" matches several ${kind}s: ${options}. Which one?`);
  throw new ApiError(422, 'unknown_name', `No ${kind} matches "${name}". Options: ${options || 'none'}.`);
}

async function resolveProject(actor: Actor, scope: Scope, name: string) {
  const { projects } = await listProjects(actor, scope, { page: 1, pageSize: 100 });
  return pickOne(projects, name, (project) => String(project.name), 'project');
}

/** A project's lead and members by name, who are the only people its tasks can go to. */
async function resolveMember(actor: Actor, scope: Scope, projectId: string, name: string): Promise<string> {
  const project = await getProject(actor, scope, projectId);
  const people = [{ id: String(project.leadId), name: project.leadName ?? '' }, ...project.members.map((member) => ({ id: member.id, name: member.name ?? '' }))];
  return pickOne(people, name, (person) => person.name, 'project member').id;
}

async function resolveTaskId(number: string): Promise<string> {
  const taskNumber = parseTaskNumber(number);
  const task = taskNumber === null ? null : await findTaskByNumber(taskNumber);
  if (!task) throw new ApiError(404, 'unknown_task', `No task ${number}.`);
  return task._id;
}

const taskShape = {
  project: z.string().min(1).max(MAX_NAME).describe('Project name'),
  assignee: z.string().min(1).max(MAX_NAME).describe('Name of a project member, or the lead'),
  title: z.string().min(1).max(300),
  description: z.string().max(MAX_TEXT).optional(),
  estimatedHours: z.number().min(0).optional().describe('Required, unless it is a QA task the tester adds for themselves'),
  dueDate: z.iso.date().optional().describe('YYYY-MM-DD, today or later'),
  kind: z.enum(TASK_KINDS).optional().describe('qa for a tester\'s own work, such as writing test cases'),
  billable: z.boolean().optional().describe('False for internal work, such as meetings'),
};

/** The Tasks module's MCP tools. Each acts with exactly the caller's Tasks permissions and reach. */
export const tasksMcpTools: McpToolProvider = (server, caller) => {
  async function newTask(input: z.infer<z.ZodObject<typeof taskShape>>) {
    const { actor, scope } = await actorFor(caller, 'task.create');
    const projectScope = (await actorFor(caller, 'project.read')).scope;
    const project = await resolveProject(actor, projectScope, input.project);
    const assignedDevId = await resolveMember(actor, projectScope, String(project.id), input.assignee);
    return createTask(actor, scope, {
      projectId: String(project.id),
      assignedDevId,
      title: input.title,
      description: input.description,
      estimatedHours: input.estimatedHours,
      dueDate: input.dueDate ? new Date(input.dueDate) : undefined,
      kind: input.kind,
      billable: input.billable,
    });
  }

  server.registerTool(
    'list_projects',
    { description: `Projects the person can see. ${instructionsNote}`, inputSchema: { status: z.enum(['active', 'on_hold', 'completed']).optional() }, annotations: { readOnlyHint: true } },
    ({ status }) =>
      answer(async () => {
        const { actor, scope } = await actorFor(caller, 'project.read');
        return listProjects(actor, scope, { page: 1, pageSize: 100, status });
      }),
  );

  server.registerTool(
    'list_project_members',
    { description: "A project's lead and members: the only people its tasks can be assigned to.", inputSchema: { project: z.string().min(1).max(MAX_NAME) }, annotations: { readOnlyHint: true } },
    ({ project: name }) =>
      answer(async () => {
        const { actor, scope } = await actorFor(caller, 'project.read');
        const project = await getProject(actor, scope, String((await resolveProject(actor, scope, name)).id));
        return { project: project.name, lead: { id: project.leadId, name: project.leadName }, members: project.members };
      }),
  );

  server.registerTool(
    'get_workload',
    {
      description: "Each person on a project with their open work in the tasks you can see: tasks to do and their estimate, and QA passes waiting on them. Use it to pick who has room.",
      inputSchema: { project: z.string().min(1).max(MAX_NAME) },
      annotations: { readOnlyHint: true },
    },
    ({ project: name }) =>
      answer(async () => {
        const { actor, scope } = await actorFor(caller, 'project.read');
        // Counting tasks needs task.read, and counts only tasks that scope reaches.
        const taskScope = (await actorFor(caller, 'task.read')).scope;
        const project = await getProject(actor, scope, String((await resolveProject(actor, scope, name)).id));
        const people = [{ id: String(project.leadId), name: project.leadName }, ...project.members];
        const work = await getOpenWork(actor, taskScope, people.map((person) => person.id));
        return people.map((person) => ({ name: person.name, ...work.get(person.id) }));
      }),
  );

  server.registerTool(
    'list_tasks',
    {
      description: 'Tasks the person can see, newest first, filtered by project, assignee, status or a title or number search.',
      inputSchema: {
        project: z.string().max(MAX_NAME).optional(),
        assignee: z.string().max(MAX_NAME).optional().describe('Needs project too'),
        status: z.enum(TASK_STATUSES).optional(),
        overdue: z.boolean().optional(),
        search: z.string().max(MAX_NAME).optional(),
        mine: z.boolean().optional().describe('Only projects the person leads'),
        page: z.number().int().min(1).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    (input) =>
      answer(async () => {
        const { actor, scope } = await actorFor(caller, 'task.read');
        let projectId: string | undefined;
        let assignedDevId: string | undefined;
        if (input.project) {
          const projectScope = (await actorFor(caller, 'project.read')).scope;
          projectId = String((await resolveProject(actor, projectScope, input.project)).id);
          if (input.assignee) assignedDevId = await resolveMember(actor, projectScope, projectId, input.assignee);
        } else if (input.assignee) {
          throw new ApiError(422, 'validation_failed', 'Name the project too, so the assignee can be found among its members.');
        }
        return listTasks(actor, scope, { page: input.page ?? 1, pageSize: LIST_PAGE_SIZE, projectId, assignedDevId, status: input.status, overdue: input.overdue, search: input.search, mine: input.mine });
      }),
  );

  server.registerTool(
    'get_task',
    { description: "One task's details and its comments.", inputSchema: { number: z.string().min(1).max(20).describe('Such as T-00102') }, annotations: { readOnlyHint: true } },
    ({ number }) =>
      answer(async () => {
        const { actor, scope } = await actorFor(caller, 'task.read');
        const taskId = await resolveTaskId(number);
        const [task, comments] = await Promise.all([getTask(actor, scope, taskId), listTaskComments(actor, scope, taskId, { page: 1, pageSize: 100 })]);
        return { ...task, comments: comments.comments };
      }),
  );

  server.registerTool('create_task', { description: `Creates one task. ${instructionsNote}`, inputSchema: taskShape }, (input) => answer(() => newTask(input)));

  server.registerTool(
    'bulk_create_tasks',
    { description: `Creates up to ${MAX_BULK_TASKS} tasks, one at a time, and reports each result, so one bad task doesn't stop the rest.`, inputSchema: { tasks: z.array(z.object(taskShape)).min(1).max(MAX_BULK_TASKS) } },
    ({ tasks }) =>
      answer(async () => {
        const results = [];
        for (const task of tasks) {
          try {
            const created = await newTask(task);
            results.push({ title: task.title, created: true, number: created.number });
          } catch (error) {
            if (!(error instanceof ApiError)) throw error;
            results.push({ title: task.title, created: false, reason: describeRefusal(error) });
          }
        }
        return results;
      }),
  );

  server.registerTool(
    'update_task',
    {
      description: "Changes a task's title, description, estimate or due date. Only the fields given change.",
      inputSchema: {
        number: z.string().min(1).max(20),
        title: z.string().min(1).max(300).optional(),
        description: z.string().max(MAX_TEXT).optional(),
        estimatedHours: z.number().min(0).optional(),
        dueDate: z.iso.date().optional(),
      },
    },
    ({ number, dueDate, ...changes }) =>
      answer(async () => {
        const { actor, scope } = await actorFor(caller, 'task.update');
        return updateTask(actor, scope, await resolveTaskId(number), { ...changes, ...(dueDate && { dueDate: new Date(dueDate) }) });
      }),
  );

  server.registerTool(
    'reassign_task',
    { description: 'Gives a task to another member of its project.', inputSchema: { number: z.string().min(1).max(20), assignee: z.string().min(1).max(MAX_NAME) } },
    ({ number, assignee }) =>
      answer(async () => {
        const { actor, scope } = await actorFor(caller, 'task.update');
        const taskId = await resolveTaskId(number);
        const task = await getTask(actor, scope, taskId);
        const assignedDevId = await resolveMember(actor, (await actorFor(caller, 'project.read')).scope, String(task.projectId), assignee);
        return updateTask(actor, scope, taskId, { assignedDevId });
      }),
  );

  server.registerTool(
    'hand_over_to_qa',
    {
      description: 'Sends a task waiting for approval to a project member for QA, optionally with the QA estimate.',
      inputSchema: { number: z.string().min(1).max(20), qa: z.string().min(1).max(MAX_NAME).describe('Name of the tester'), qaEstimatedHours: z.number().positive().optional() },
    },
    ({ number, qa, qaEstimatedHours }) =>
      answer(async () => {
        const { actor, scope } = await actorFor(caller, 'task.update');
        const taskId = await resolveTaskId(number);
        const task = await getTask(actor, scope, taskId);
        const qaId = await resolveMember(actor, (await actorFor(caller, 'project.read')).scope, String(task.projectId), qa);
        return handOverToQa(actor, scope, taskId, { qaId, qaEstimatedHours });
      }),
  );
};

