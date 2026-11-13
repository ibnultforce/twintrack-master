import { randomUUID } from 'node:crypto';
import type { ClientSession, UpdateQuery } from 'mongoose';
import { runInTransaction } from '../../../db.js';
import { ApiError } from '../../../lib/errors.js';
import type { PageRequest } from '../../../lib/query.js';
import { actorFields, type Actor } from '../../master/access/caller.js';
import { peopleInScope } from '../../master/access/scope.js';
import { recordAudit } from '../../master/audit/audit.repository.js';
import type { Scope } from '../../master/moduleRegistry/manifest.js';
import { assertMayWriteFields, readFieldRules, redactHistory, redactRecord, type FieldRules } from '../../master/records/fieldSecurity.service.js';
import { assertCanReachRecord, findSharedRecordIds, findSharingModel, type RecordNeed } from '../../master/records/recordAccess.service.js';
import { listRecordHistory, writeRecordHistory } from '../../master/records/recordHistory.service.js';
import type { ProjectDoc } from '../models/project.js';
import type { QaResult, TaskDoc, TaskKind } from '../models/task.js';
import type { TaskCommentDoc } from '../models/taskComment.js';
import { insertPointsEntries, type NewPointsEntry } from '../points/points.repository.js';
import { pointsEntryFor } from '../points/points.service.js';
import { findProjectById, findProjectIdsLedBy, findProjectsByIds } from '../project/project.repository.js';
import { assertCanReachProject, isProjectMember, requireProject } from '../project/project.service.js';
import { assertPeopleExist, findPeopleNames, TASKS_MODULE_KEY } from '../tasksModule.js';
import {
  findCommentsPage,
  findTaskById,
  findTasksByIds,
  findTasksForExport,
  findTasksPage,
  findTasksReferencing,
  insertComment,
  insertTask,
  saveTask,
  searchTaskSummaries,
  sumOpenWork,
  sumTasks,
  takeNextTaskNumber,
  taskNotFound,
  type NewTaskRecord,
  type TaskListFilter,
  type TaskSort,
} from './task.repository.js';
import {
  assertCancellable,
  assertStepAllowed,
  chooseApprovedHours,
  formatTaskNumber,
  pointsForHours,
  revertPenaltyFor,
  secondsToHours,
  secondsWorked,
  type HoursChoice,
  type TaskStep,
} from './taskLifecycle.js';

const TASK_RESOURCE = 'task';

export type NewTaskDetails = Pick<NewTaskRecord, 'projectId' | 'title' | 'description' | 'assignedDevId' | 'dueDate'> & {
  tlId?: string;
  kind?: TaskKind;
  /** Optional only for a QA task its tester adds for themselves. */
  estimatedHours?: number;
  billable?: boolean;
  referencedTaskIds?: string[];
};
export type TaskDetailChanges = Partial<Pick<TaskDoc, 'title' | 'description' | 'estimatedHours' | 'dueDate' | 'assignedDevId' | 'tlId'>>;
/** `mine` keeps the list to projects the caller leads. */
export type TaskFilterRequest = Omit<TaskListFilter, 'reach' | 'projectIds'> & { mine?: boolean };
export type TaskListRequest = PageRequest & TaskFilterRequest & Partial<TaskSort>;

/** The most rows an export holds. Narrow the filters for more. */
const MAX_EXPORT_ROWS = 5000;
const SEARCH_RESULT_LIMIT = 15;

interface TaskContext {
  task: TaskDoc;
  project: ProjectDoc;
}

const historyRef = (taskId: string) => ({ module: TASKS_MODULE_KEY, object: TASK_RESOURCE, recordId: taskId });
const fieldRulesFor = (actor: Actor) => readFieldRules(actor, TASKS_MODULE_KEY, TASK_RESOURCE);

/**
 * The people a task belongs to: the assignee first, as its owner, then its TL, its QA and the project lead.
 * A scope that reaches any of them reaches the task.
 */
function taskPeople(task: Pick<TaskDoc, 'assignedDevId' | 'tlId' | 'qaId'>, project: Pick<ProjectDoc, 'leadId'>): string[] {
  return [...new Set([task.assignedDevId, task.tlId, task.qaId, project.leadId].filter((id): id is string => Boolean(id)))];
}

const assertCanReachTask = (actor: Actor, scope: Scope, { task, project }: TaskContext, need: RecordNeed) =>
  assertCanReachRecord(actor, scope, { ...historyRef(task._id), peopleIds: taskPeople(task, project) }, need);

/** For features on a task, such as its files: refuses a task that doesn't exist or is beyond the caller's reach. */
export async function assertCanReachTaskById(actor: Actor, scope: Scope, taskId: string, need: RecordNeed): Promise<void> {
  await assertCanReachTask(actor, scope, await requireTaskContext(taskId), need);
}

async function requireTaskContext(taskId: string): Promise<TaskContext> {
  const task = await findTaskById(taskId);
  if (!task) throw taskNotFound();
  const project = await findProjectById(task.projectId);
  if (!project) throw new Error(`Task ${taskId} points to project ${task.projectId}, which is missing.`);
  return { task, project };
}

function assertIsProjectMember(project: ProjectDoc, personId: string, field: string): void {
  if (!isProjectMember(project, personId)) {
    throw new ApiError(422, 'validation_failed', 'Some fields are invalid.', [{ path: field, message: 'must be the project lead or a member' }]);
  }
}

/** Timer steps belong to the person doing the work. Holding a wider permission doesn't let anyone run someone else's timer. */
function assertIsAssignee(actor: Actor, task: TaskDoc): void {
  if (task.assignedDevId !== actor.user._id) throw new ApiError(403, 'not_assignee', 'Only the person this task is assigned to can do that.');
}

function assertIsQa(actor: Actor, task: TaskDoc): void {
  if (task.qaId !== actor.user._id) throw new ApiError(403, 'not_qa', 'Only the person doing QA on this task can do that.');
}

/** Nobody approves or reverts work they did themselves, whatever their permissions. */
function assertNotOwnWork(actor: Actor, task: TaskDoc): void {
  if (actor.user._id === task.assignedDevId || actor.user._id === task.qaId) {
    throw new ApiError(403, 'own_work', "You can't approve or revert a task you worked on or tested.");
  }
}

type TaskSummary = Pick<TaskDoc, '_id' | 'taskNumber' | 'status'>;
const toTaskLink = (task: TaskSummary) => ({ id: task._id, number: formatTaskNumber(task.taskNumber), status: task.status });

function toTaskView(task: TaskDoc, project: Pick<ProjectDoc, '_id' | 'name'> | undefined, rules: FieldRules) {
  return redactRecord({
    id: task._id,
    number: formatTaskNumber(task.taskNumber),
    projectId: task.projectId,
    projectName: project?.name,
    kind: task.kind ?? 'development',
    title: task.title,
    description: task.description,
    status: task.status,
    assignedDevId: task.assignedDevId,
    tlId: task.tlId,
    dueDate: task.dueDate,
    estimatedHours: task.estimatedHours,
    actualHours: task.actualHours,
    approvedHours: task.approvedHours,
    pointValue: task.pointValue ?? 0,
    billable: task.billable ?? true,
    flagged: task.flagged ?? false,
    flagNote: task.flagNote,
    paused: task.paused,
    workedSeconds: secondsWorked(task, new Date()),
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    approvedBy: task.approvedBy,
    approvedAt: task.approvedAt,
    revertCount: task.revertCount,
    qaId: task.qaId,
    qaEstimatedHours: task.qaEstimatedHours,
    qaActualHours: task.qaActualHours,
    qaApprovedHours: task.qaApprovedHours,
    qaPointValue: task.qaPointValue,
    qaPaused: task.qaPaused,
    qaCompletedAt: task.qaCompletedAt,
    qaResult: task.qaResult,
    cancelledBy: task.cancelledBy,
    cancelledAt: task.cancelledAt,
    version: task.version,
    createdBy: task.createdBy,
    createdAt: task.createdAt,
    updatedBy: task.updatedBy,
    updatedAt: task.updatedAt,
  }, rules);
}

const taskAuditFields = (actor: Actor, task: TaskDoc) => ({
  ...actorFields(actor),
  targetType: TASK_RESOURCE,
  targetId: task._id,
  targetName: formatTaskNumber(task.taskNumber),
  module: TASKS_MODULE_KEY,
});

const toCommentView = (comment: TaskCommentDoc) => ({
  id: comment._id,
  authorId: comment.authorId,
  authorName: comment.authorName,
  body: comment.body,
  createdAt: comment.createdAt,
});

const newComment = (actor: Actor, taskId: string, body: string) => ({ _id: `tc_${randomUUID()}`, taskId, authorId: actor.user._id, authorName: actor.user.name, body });

async function reachForList(actor: Actor, scope: Scope) {
  if ((await findSharingModel(TASKS_MODULE_KEY, TASK_RESOURCE)) !== 'private') return undefined;
  const peopleIds = await peopleInScope(actor.user._id, scope);
  if (!peopleIds) return undefined;
  const [projectIds, sharedIds] = await Promise.all([
    findProjectIdsLedBy(peopleIds),
    findSharedRecordIds(actor.user, TASKS_MODULE_KEY, TASK_RESOURCE, 'read'),
  ]);
  return { peopleIds, projectIds, sharedIds };
}

/** The caller's filters as the repository takes them, inside what their scope reaches. */
async function toTaskFilter(actor: Actor, scope: Scope, { mine, ...filters }: TaskFilterRequest): Promise<TaskListFilter> {
  return {
    ...filters,
    reach: await reachForList(actor, scope),
    ...(mine && { projectIds: await findProjectIdsLedBy([actor.user._id]) }),
  };
}

export async function listTasks(actor: Actor, scope: Scope, request: TaskListRequest) {
  const { page, pageSize, sortBy, sortDirection, ...filters } = request;
  const { tasks, total } = await findTasksPage({ page, pageSize, sortBy, sortDirection, ...(await toTaskFilter(actor, scope, filters)) });
  const projects = await findProjectsByIds([...new Set(tasks.map((task) => task.projectId))]);
  const projectById = new Map(projects.map((project) => [project._id, project]));
  const rules = await fieldRulesFor(actor);
  return { scope, total, tasks: tasks.map((task) => toTaskView(task, projectById.get(task.projectId), rules)) };
}

/** Totals over every task the filters match within the caller's scope, for the list's summary line. */
/**
 * Each person's open work, counting only tasks the caller's task scope reaches. Hours whose fields are hidden from
 * the caller are left out, as on the tasks themselves.
 */
export async function getOpenWork(actor: Actor, scope: Scope, userIds: string[]) {
  const [work, rules] = await Promise.all([sumOpenWork(userIds, await toTaskFilter(actor, scope, {})), fieldRulesFor(actor)]);
  return new Map(
    [...work].map(([userId, { openEstimatedHours, openQaEstimatedHours, ...counts }]) => {
      const hours = redactRecord({ estimatedHours: openEstimatedHours, qaEstimatedHours: openQaEstimatedHours }, rules);
      return [userId, { ...counts, openEstimatedHours: hours.estimatedHours, openQaEstimatedHours: hours.qaEstimatedHours }];
    }),
  );
}

export async function summarizeTasks(actor: Actor, scope: Scope, filters: TaskFilterRequest) {
  const { varianceHours, ...totals } = await sumTasks(await toTaskFilter(actor, scope, filters));
  const rules = await fieldRulesFor(actor);
  // Hidden fields stay hidden in sums too, so a total can't give away what the rows don't show. Variance isn't a
  // field, but it is actual minus estimated hours, so it shows only when both of those do.
  const visible = redactRecord(totals, rules);
  const showsVariance = visible.actualHours !== undefined && visible.estimatedHours !== undefined;
  return { scope, ...visible, ...(showsVariance && { varianceHours }) };
}

const CSV_COLUMNS = ['number', 'title', 'projectName', 'status', 'assignedDevName', 'tlName', 'estimatedHours', 'actualHours', 'approvedHours', 'pointValue', 'billable', 'flagged', 'dueDate', 'completedAt'] as const;

const csvCell = (value: unknown) => {
  if (value === undefined || value === null) return '';
  const text = value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
  // Quotes keep commas and line breaks inside one cell, and a leading = or + can't run as a spreadsheet formula.
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

/** The filtered tasks as CSV, one row per task, with fields the caller may not see left empty. */
export async function exportTasksCsv(actor: Actor, scope: Scope, filters: TaskFilterRequest): Promise<string> {
  const tasks = await findTasksForExport(await toTaskFilter(actor, scope, filters), MAX_EXPORT_ROWS);
  const [projects, names, rules] = await Promise.all([
    findProjectsByIds([...new Set(tasks.map((task) => task.projectId))]),
    findPeopleNames(tasks.flatMap((task) => [task.assignedDevId, task.tlId])),
    fieldRulesFor(actor),
  ]);
  const projectById = new Map(projects.map((project) => [project._id, project]));
  const rows = tasks.map((task) => {
    const view: Record<string, unknown> = {
      ...toTaskView(task, projectById.get(task.projectId), rules),
      assignedDevName: names.get(task.assignedDevId),
      tlName: names.get(task.tlId),
    };
    return CSV_COLUMNS.map((column) => csvCell(view[column])).join(',');
  });
  return [CSV_COLUMNS.join(','), ...rows].join('\r\n');
}

/** A few tasks matching a title or number, for pickers such as the one for references. */
export async function searchTasks(actor: Actor, scope: Scope, search: string) {
  const tasks = await searchTaskSummaries(await toTaskFilter(actor, scope, { search }), SEARCH_RESULT_LIMIT);
  const [projectList, rules] = await Promise.all([findProjectsByIds([...new Set(tasks.map((task) => task.projectId))]), fieldRulesFor(actor)]);
  const projects = new Map(projectList.map((project) => [project._id, project.name]));
  // The title is a controlled field, so it stays hidden here as it does on the task itself.
  return { tasks: tasks.map((task) => redactRecord({ ...toTaskLink(task), title: task.title, projectName: projects.get(task.projectId) }, rules)) };
}

/** One task, with the tasks it points to and the tasks pointing to it. */
export async function getTask(actor: Actor, scope: Scope, taskId: string) {
  const context = await requireTaskContext(taskId);
  await assertCanReachTask(actor, scope, context, 'read');
  const [references, referencedBy] = await Promise.all([findTasksByIds(context.task.referencedTaskIds), findTasksReferencing(taskId)]);
  return {
    ...toTaskView(context.task, context.project, await fieldRulesFor(actor)),
    references: references.map(toTaskLink),
    referencedBy: referencedBy.map(toTaskLink),
  };
}

const invalidField = (path: string, message: string) => new ApiError(422, 'validation_failed', 'Some fields are invalid.', [{ path, message }]);

/** A due date may be today, but not a day that has already passed. */
function assertNotInPast(dueDate: Date | undefined): void {
  const startOfToday = new Date();
  startOfToday.setUTCHours(0, 0, 0, 0);
  if (dueDate && dueDate < startOfToday) throw invalidField('dueDate', "can't be in the past");
}

/** Only a tester adding a QA task for themselves may leave the estimate out. Everyone else plans hours up front. */
function estimateFor(actor: Actor, details: NewTaskDetails): number {
  if (details.estimatedHours !== undefined) return details.estimatedHours;
  if (details.kind === 'qa' && details.assignedDevId === actor.user._id) return 0;
  throw invalidField('estimatedHours', 'is required, unless you add a QA task for yourself');
}

async function assertTasksExist(taskIds: string[], exceptId?: string): Promise<void> {
  if (exceptId && taskIds.includes(exceptId)) throw invalidField('referencedTaskIds', "can't include the task itself");
  const found = await findTasksByIds(taskIds);
  if (found.length !== taskIds.length) throw invalidField('referencedTaskIds', 'names a task that does not exist');
}

export async function createTask(actor: Actor, scope: Scope, details: NewTaskDetails) {
  const project = await requireProject(details.projectId);
  await assertCanReachProject(actor, scope, project, 'read');
  if (project.status === 'completed') throw new ApiError(409, 'project_closed', 'This project is completed, so it takes no new tasks.');
  assertNotInPast(details.dueDate);
  const estimatedHours = estimateFor(actor, details);

  const tlId = details.tlId ?? actor.user._id;
  await assertPeopleExist({ assignedDevId: details.assignedDevId, tlId });
  assertIsProjectMember(project, details.assignedDevId, 'assignedDevId');
  const referencedTaskIds = [...new Set(details.referencedTaskIds ?? [])];
  await assertTasksExist(referencedTaskIds);
  const taskId = `t_${randomUUID()}`;
  // The new task has no shares yet, so this checks the caller's scope reaches the people it will belong to.
  await assertCanReachRecord(actor, scope, { ...historyRef(taskId), peopleIds: taskPeople({ ...details, tlId }, project) }, 'edit');

  const rules = await fieldRulesFor(actor);
  assertMayWriteFields(rules, Object.keys(details), 'create');

  const record: NewTaskRecord = {
    ...details,
    kind: details.kind ?? 'development',
    estimatedHours,
    billable: details.billable ?? true,
    pointValue: pointsForHours(estimatedHours),
    referencedTaskIds,
    tlId,
    _id: taskId,
    taskNumber: await takeNextTaskNumber(),
  };
  const task = await runInTransaction(async (session) => {
    const created = await insertTask(record, actor.user._id, session);
    await writeRecordHistory(historyRef(created._id), { action: 'created', actor, after: created }, session);
    await recordAudit({ action: 'task.created', ...taskAuditFields(actor, created) }, session);
    return created;
  });
  return toTaskView(task, project, rules);
}

interface StepDefinition {
  /** Which statuses the step may start from. Cancelling, which works from any open status, checks its own. */
  step?: TaskStep;
  auditAction: string;
  need: RecordNeed;
  /** The version the caller last read. Steps that don't send one are still guarded by the version loaded here. */
  version?: number;
  /** Rules about who may take this step on this task, beyond holding the permission and reaching the task. */
  check?: (context: TaskContext) => void | Promise<void>;
  /** Fields the caller sets in this step, which need edit access to each. Fields the step itself moves on, such as status, aren't listed. */
  writes?: string[];
  buildUpdate: (context: TaskContext, now: Date) => UpdateQuery<TaskDoc>;
  /** A comment saved with the change, such as the reason for a revert. */
  comment?: string;
  /** Points earned or lost with this step, saved in the same transaction. */
  points?: (context: TaskContext, saved: TaskDoc) => NewPointsEntry[];
}

/**
 * Runs one step of a task's life: checks the status, reach and who's asking, then saves the change with its
 * history, its activity log entry and any comment in one transaction.
 */
async function runStep(actor: Actor, scope: Scope, taskId: string, definition: StepDefinition) {
  const context = await requireTaskContext(taskId);
  if (definition.step) assertStepAllowed(definition.step, context.task.status);
  await assertCanReachTask(actor, scope, context, definition.need);
  await definition.check?.(context);
  // After the reach check, so someone outside it learns nothing about the fields.
  const rules = await fieldRulesFor(actor);
  assertMayWriteFields(rules, definition.writes ?? [], 'update');

  const update = definition.buildUpdate(context, new Date());
  const saved = await runInTransaction(async (session: ClientSession) => {
    const result = await saveTask(taskId, update, { actorId: actor.user._id, expectedVersion: definition.version ?? context.task.version, session });
    await writeRecordHistory(historyRef(taskId), { action: 'updated', actor, before: context.task, after: result }, session);
    await recordAudit({ action: definition.auditAction, ...taskAuditFields(actor, result) }, session);
    if (definition.comment) await insertComment(newComment(actor, taskId, definition.comment), session);
    if (definition.points) await insertPointsEntries(definition.points(context, result), session);
    return result;
  });
  return toTaskView(saved, context.project, rules);
}

export async function updateTask(actor: Actor, scope: Scope, taskId: string, changes: TaskDetailChanges & { version?: number }) {
  const { version, ...fields } = changes;
  await assertPeopleExist({ assignedDevId: fields.assignedDevId, tlId: fields.tlId });
  return runStep(actor, scope, taskId, {
    step: 'edit',
    auditAction: 'task.updated',
    need: 'edit',
    version,
    writes: Object.keys(fields),
    check: async ({ task, project }) => {
      if (!fields.assignedDevId || fields.assignedDevId === task.assignedDevId) return;
      assertIsProjectMember(project, fields.assignedDevId, 'assignedDevId');
      // While a QA round is open or its result stands, the tester can't become the assignee and test their own work.
      const hasQaRound = task.status === 'qa_todo' || task.status === 'qa_in_progress' || Boolean(task.qaCompletedAt);
      if (hasQaRound && fields.assignedDevId === task.qaId) throw invalidField('assignedDevId', "can't be the person doing QA on this task");
      if (task.resumedAt) throw new ApiError(409, 'timer_running', 'The assignee is working on this task. They need to pause it before it moves to someone else.');
      // The new assignee must also be inside the caller's reach, as on create.
      await assertCanReachRecord(actor, scope, { ...historyRef(taskId), peopleIds: [fields.assignedDevId] }, 'edit');
    },
    buildUpdate: ({ task }) => ({
      $set: {
        ...fields,
        // Points follow the estimate until approval settles the hours.
        ...(fields.estimatedHours !== undefined && task.status !== 'done' && { pointValue: pointsForHours(fields.estimatedHours) }),
      },
    }),
  });
}

/** Starts the assignee's timer, or resumes it after a pause. */
export function startTask(actor: Actor, scope: Scope, taskId: string) {
  return runStep(actor, scope, taskId, {
    step: 'start',
    auditAction: 'task.started',
    need: 'read',
    check: ({ task }) => {
      assertIsAssignee(actor, task);
      if (task.resumedAt) throw new ApiError(409, 'timer_running', 'The timer is already running.');
    },
    buildUpdate: ({ task }, now) => ({ $set: { status: 'in_progress', paused: false, resumedAt: now, startedAt: task.startedAt ?? now } }),
  });
}

export function pauseTask(actor: Actor, scope: Scope, taskId: string) {
  return runStep(actor, scope, taskId, {
    step: 'pause',
    auditAction: 'task.paused',
    need: 'read',
    check: ({ task }) => {
      assertIsAssignee(actor, task);
      if (!task.resumedAt) throw new ApiError(409, 'timer_paused', 'The timer is already paused.');
    },
    buildUpdate: ({ task }, now) => ({ $set: { paused: true, accumulatedSeconds: secondsWorked(task, now) }, $unset: { resumedAt: 1 } }),
  });
}

/**
 * Stops the timer, records the hours worked, and sends the task for approval. A QA task is its tester's own pass,
 * so completing it records pass or fail. Other tasks get their result from a separate QA round, if any.
 */
export function completeTask(actor: Actor, scope: Scope, taskId: string, result?: QaResult) {
  return runStep(actor, scope, taskId, {
    step: 'complete',
    auditAction: 'task.completed',
    need: 'read',
    check: ({ task }) => {
      assertIsAssignee(actor, task);
      if (task.kind === 'qa' && !result) throw invalidField('result', 'is required, because this is a QA task');
      if (task.kind !== 'qa' && result) throw invalidField('result', 'is only for QA tasks. Hand the task to QA for a result');
    },
    buildUpdate: ({ task }, now) => {
      const seconds = secondsWorked(task, now);
      return {
        $set: {
          status: 'pending_approval',
          paused: false,
          accumulatedSeconds: seconds,
          actualHours: secondsToHours(seconds),
          completedAt: now,
          ...(result && { qaResult: result }),
        },
        $unset: { resumedAt: 1 },
      };
    },
  });
}

/** Hands a completed task to someone for QA. Any earlier QA round is cleared. */
export function handOverToQa(actor: Actor, scope: Scope, taskId: string, handover: { qaId: string; qaEstimatedHours?: number }) {
  return runStep(actor, scope, taskId, {
    step: 'qaHandover',
    auditAction: 'task.qa_handed_over',
    need: 'edit',
    writes: handover.qaEstimatedHours === undefined ? [] : ['qaEstimatedHours'],
    check: async ({ task, project }) => {
      await assertPeopleExist({ qaId: handover.qaId });
      assertIsProjectMember(project, handover.qaId, 'qaId');
      if (task.kind === 'qa') throw new ApiError(409, 'qa_task', 'A QA task is already its own test pass, so it is never handed to QA.');
      if (handover.qaId === task.assignedDevId) throw invalidField('qaId', "can't be the person who did the work");
    },
    buildUpdate: () => {
      const estimate = handover.qaEstimatedHours;
      return {
        $set: {
          status: 'qa_todo',
          qaId: handover.qaId,
          qaPaused: false,
          qaAccumulatedSeconds: 0,
          ...(estimate !== undefined && { qaEstimatedHours: estimate, qaPointValue: pointsForHours(estimate) }),
        },
        // A new round starts clean, including the estimate unless one comes with it.
        $unset: {
          qaResumedAt: 1,
          qaActualHours: 1,
          qaApprovedHours: 1,
          qaCompletedAt: 1,
          qaResult: 1,
          ...(estimate === undefined && { qaEstimatedHours: 1, qaPointValue: 1 }),
        },
      };
    },
  });
}

/** Sets or changes the QA estimate, which QA works against. It locks once QA starts, unless QA started without one. */
export function setQaEstimate(actor: Actor, scope: Scope, taskId: string, request: { qaEstimatedHours: number; version?: number }) {
  return runStep(actor, scope, taskId, {
    step: 'qaEstimate',
    auditAction: 'task.qa_estimate_set',
    need: 'edit',
    version: request.version,
    writes: ['qaEstimatedHours'],
    check: ({ task }) => {
      // Tasks handed over before estimates were required can reach QA without one, and need one to resume.
      if (task.status === 'qa_in_progress' && task.qaEstimatedHours !== undefined) {
        throw new ApiError(409, 'qa_estimate_locked', 'QA has started, so its estimate can no longer change.');
      }
    },
    buildUpdate: () => ({ $set: { qaEstimatedHours: request.qaEstimatedHours, qaPointValue: pointsForHours(request.qaEstimatedHours) } }),
  });
}

const qaTimer = (task: TaskDoc) => ({ accumulatedSeconds: task.qaAccumulatedSeconds, resumedAt: task.qaResumedAt });

/** Starts the QA timer, or resumes it after a pause. */
export function startQa(actor: Actor, scope: Scope, taskId: string) {
  return runStep(actor, scope, taskId, {
    step: 'qaStart',
    auditAction: 'task.qa_started',
    need: 'read',
    check: ({ task }) => {
      assertIsQa(actor, task);
      if (task.qaResumedAt) throw new ApiError(409, 'timer_running', 'The QA timer is already running.');
      if (task.qaEstimatedHours === undefined) throw new ApiError(409, 'qa_estimate_missing', 'QA needs an estimate before it starts. Ask the task lead to set one.');
    },
    buildUpdate: (_context, now) => ({ $set: { status: 'qa_in_progress', qaPaused: false, qaResumedAt: now } }),
  });
}

export function pauseQa(actor: Actor, scope: Scope, taskId: string) {
  return runStep(actor, scope, taskId, {
    step: 'qaPause',
    auditAction: 'task.qa_paused',
    need: 'read',
    check: ({ task }) => {
      assertIsQa(actor, task);
      if (!task.qaResumedAt) throw new ApiError(409, 'timer_paused', 'The QA timer is already paused.');
    },
    buildUpdate: ({ task }, now) => ({ $set: { qaPaused: true, qaAccumulatedSeconds: secondsWorked(qaTimer(task), now) }, $unset: { qaResumedAt: 1 } }),
  });
}

/** Stops the QA timer, records the result, and sends the task back for approval. */
export function completeQa(actor: Actor, scope: Scope, taskId: string, result: QaResult) {
  return runStep(actor, scope, taskId, {
    step: 'qaComplete',
    auditAction: 'task.qa_completed',
    need: 'read',
    check: ({ task }) => assertIsQa(actor, task),
    buildUpdate: ({ task }, now) => {
      const seconds = secondsWorked(qaTimer(task), now);
      return {
        $set: { status: 'pending_approval', qaPaused: false, qaAccumulatedSeconds: seconds, qaActualHours: secondsToHours(seconds), qaCompletedAt: now, qaResult: result },
        $unset: { qaResumedAt: 1 },
      };
    },
  });
}

/** Settles the hours for the work, and for QA when there was any, and marks the task done. */
export function approveTask(actor: Actor, scope: Scope, taskId: string, approval: { hours: HoursChoice; qaHours?: HoursChoice; version?: number }) {
  return runStep(actor, scope, taskId, {
    step: 'approve',
    auditAction: 'task.approved',
    need: 'edit',
    version: approval.version,
    check: ({ task }) => {
      assertNotOwnWork(actor, task);
      if (task.qaCompletedAt && !approval.qaHours) {
        throw new ApiError(422, 'validation_failed', 'Some fields are invalid.', [{ path: 'qaHours', message: 'is required, because this task went through QA' }]);
      }
    },
    writes: approval.qaHours ? ['qaApprovedHours'] : [],
    buildUpdate: ({ task }, now) => {
      const approvedHours = chooseApprovedHours(approval.hours, { estimated: task.estimatedHours, actual: task.actualHours ?? 0 }, 'hours');
      const qaApprovedHours = task.qaCompletedAt && approval.qaHours
        ? chooseApprovedHours(approval.qaHours, { estimated: task.qaEstimatedHours ?? 0, actual: task.qaActualHours ?? 0 }, 'qaHours')
        : undefined;
      return {
        $set: {
          status: 'done',
          approvedHours,
          pointValue: pointsForHours(approvedHours),
          approvedBy: actor.user._id,
          approvedAt: now,
          ...(qaApprovedHours !== undefined && { qaApprovedHours, qaPointValue: pointsForHours(qaApprovedHours) }),
        },
      };
    },
    // Points are earned once, here: the assignee for the work, and QA for their pass.
    points: (_context, saved) => [
      pointsEntryFor(saved, saved.assignedDevId, saved.pointValue, 'task_approved', actor),
      ...(saved.qaId && saved.qaPointValue !== undefined && saved.qaApprovedHours !== undefined
        ? [pointsEntryFor(saved, saved.qaId, saved.qaPointValue, 'qa_approved', actor)]
        : []),
    ].filter((entry) => entry.points !== 0),
  });
}

/**
 * Sends the task back, with the reason as a comment. A done task can be reverted when a bug turns up later, and
 * given to someone else to fix. The penalty always falls on whoever had the task when it was reverted, because they
 * did the work being sent back. As in the old app, every revert costs 5% of the task's points, including one from
 * pending approval: it is the price of sending work for review that wasn't ready.
 *
 * Reverting a done task also takes back the points its approval gave the assignee and QA, since approving it again
 * gives them afresh. The finished QA round is cleared too, since it tested the work being sent back. Giving the fix
 * to someone else starts their timer from zero.
 */
export function revertTask(actor: Actor, scope: Scope, taskId: string, request: { reason: string; assignedDevId?: string }) {
  const { reason, assignedDevId } = request;
  return runStep(actor, scope, taskId, {
    step: 'revert',
    auditAction: 'task.reverted',
    need: 'edit',
    check: async ({ task, project }) => {
      assertNotOwnWork(actor, task);
      if (!assignedDevId || assignedDevId === task.assignedDevId) return;
      await assertPeopleExist({ assignedDevId });
      assertIsProjectMember(project, assignedDevId, 'assignedDevId');
      await assertCanReachRecord(actor, scope, { ...historyRef(taskId), peopleIds: [assignedDevId] }, 'edit');
    },
    comment: reason,
    buildUpdate: ({ task }) => {
      const isReassigned = Boolean(assignedDevId) && assignedDevId !== task.assignedDevId;
      return {
        $set: {
          status: 'reverted',
          paused: false,
          assignedDevId: assignedDevId ?? task.assignedDevId,
          pointValue: pointsForHours(task.estimatedHours),
          ...(isReassigned && { accumulatedSeconds: 0 }),
        },
        $inc: { revertCount: 1 },
        // The QA round tested the work being sent back, so the fix needs a new one before its result counts again.
        $unset: { resumedAt: 1, completedAt: 1, approvedHours: 1, qaApprovedHours: 1, qaCompletedAt: 1, qaResult: 1, approvedBy: 1, approvedAt: 1, ...(isReassigned && { actualHours: 1 }) },
      };
    },
    points: ({ task }) => {
      const entries = [];
      if (task.status === 'done') {
        if (task.pointValue) entries.push(pointsEntryFor(task, task.assignedDevId, -task.pointValue, 'approval_reversed', actor));
        if (task.qaId && task.qaApprovedHours !== undefined && task.qaPointValue) {
          entries.push(pointsEntryFor(task, task.qaId, -task.qaPointValue, 'approval_reversed', actor));
        }
      }
      const penalty = revertPenaltyFor(task.pointValue ?? 0);
      if (penalty > 0) entries.push(pointsEntryFor(task, task.assignedDevId, -penalty, 'revert_penalty', actor));
      return entries;
    },
  });
}

/** Raises or clears a flag for follow-up, at any status, including done. Who may is decided by field access to flagged. */
export function flagTask(actor: Actor, scope: Scope, taskId: string, request: { flagged: boolean; flagNote?: string }) {
  return runStep(actor, scope, taskId, {
    auditAction: request.flagged ? 'task.flagged' : 'task.unflagged',
    need: 'edit',
    writes: ['flagged', ...(request.flagNote !== undefined ? ['flagNote'] : [])],
    buildUpdate: () => (request.flagged
      ? { $set: { flagged: true, ...(request.flagNote !== undefined && { flagNote: request.flagNote }) } }
      : { $set: { flagged: false }, $unset: { flagNote: 1 } }),
  });
}

/** Marks the hours as billed to the client or not. Internal work, such as meetings or rework, isn't. */
export function setTaskBillable(actor: Actor, scope: Scope, taskId: string, billable: boolean) {
  return runStep(actor, scope, taskId, {
    auditAction: 'task.billable_changed',
    need: 'edit',
    writes: ['billable'],
    check: ({ task }) => {
      if (task.status === 'cancelled') throw new ApiError(409, 'invalid_status', "A cancelled task can't change its billing.");
    },
    buildUpdate: () => ({ $set: { billable } }),
  });
}

/**
 * Corrects the hours the timer recorded, for when it came out wrong, such as a long break nobody paused for. Only
 * works once the task has actual hours. Approved hours and points don't change: revert and approve again for that.
 */
export function adjustActualHours(actor: Actor, scope: Scope, taskId: string, request: { actualHours: number; version?: number }) {
  return runStep(actor, scope, taskId, {
    auditAction: 'task.actual_hours_adjusted',
    need: 'edit',
    version: request.version,
    writes: ['actualHours'],
    check: ({ task }) => {
      if (task.actualHours === undefined) throw new ApiError(409, 'no_actual_hours', 'This task has no actual hours yet. They are recorded when it is completed.');
    },
    buildUpdate: () => ({ $set: { actualHours: request.actualHours } }),
  });
}

export function cancelTask(actor: Actor, scope: Scope, taskId: string) {
  return runStep(actor, scope, taskId, {
    auditAction: 'task.cancelled',
    need: 'edit',
    check: ({ task }) => assertCancellable(task.status),
    buildUpdate: ({ task }, now) => ({
      $set: {
        status: 'cancelled',
        cancelledBy: actor.user._id,
        cancelledAt: now,
        paused: false,
        qaPaused: false,
        accumulatedSeconds: secondsWorked(task, now),
        qaAccumulatedSeconds: secondsWorked(qaTimer(task), now),
      },
      $unset: { resumedAt: 1, qaResumedAt: 1 },
    }),
  });
}

/** Replaces the tasks this one points to. Each must exist and can't be the task itself. */
export async function setTaskReferences(actor: Actor, scope: Scope, taskId: string, referencedTaskIds: string[]) {
  const wanted = [...new Set(referencedTaskIds)];
  const found = new Set((await findTasksByIds(wanted)).map((task) => task._id));
  const invalid = wanted.flatMap((id, index) => {
    if (id === taskId) return [{ path: `taskIds.${index}`, message: "can't be the task itself" }];
    return found.has(id) ? [] : [{ path: `taskIds.${index}`, message: 'no such task' }];
  });
  if (invalid.length > 0) throw new ApiError(422, 'validation_failed', 'Some fields are invalid.', invalid);

  return runStep(actor, scope, taskId, {
    auditAction: 'task.references_changed',
    need: 'edit',
    buildUpdate: () => ({ $set: { referencedTaskIds: wanted } }),
  });
}

/** What changed and who changed it. Changes to QA hours stay hidden from anyone who can't see those fields. */
export async function getTaskHistory(actor: Actor, scope: Scope, taskId: string, page: PageRequest) {
  const context = await requireTaskContext(taskId);
  await assertCanReachTask(actor, scope, context, 'read');
  const history = await listRecordHistory(historyRef(taskId), page);
  return { ...history, entries: redactHistory(history.entries, await fieldRulesFor(actor)) };
}

export async function listTaskComments(actor: Actor, scope: Scope, taskId: string, page: PageRequest) {
  await assertCanReachTask(actor, scope, await requireTaskContext(taskId), 'read');
  const { comments, total } = await findCommentsPage(taskId, page);
  return { total, comments: comments.map(toCommentView) };
}

/** Anyone who can read a task can comment on it. Comments are kept for good, so there's no edit or delete. */
export async function addTaskComment(actor: Actor, scope: Scope, taskId: string, body: string) {
  const context = await requireTaskContext(taskId);
  await assertCanReachTask(actor, scope, context, 'read');
  const comment = await runInTransaction(async (session) => {
    const created = await insertComment(newComment(actor, taskId, body), session);
    await recordAudit({ action: 'task.commented', ...taskAuditFields(actor, context.task) }, session);
    return created;
  });
  return toCommentView(comment);
}
