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
import type { QaResult, TaskDoc } from '../models/task.js';
import type { TaskCommentDoc } from '../models/taskComment.js';
import { findProjectById, findProjectIdsLedBy, findProjectsByIds } from '../project/project.repository.js';
import { assertCanReachProject, isProjectMember, requireProject } from '../project/project.service.js';
import { assertPeopleExist, TASKS_MODULE_KEY } from '../tasksModule.js';
import {
  findCommentsPage,
  findTaskById,
  findTasksByIds,
  findTasksPage,
  findTasksReferencing,
  insertComment,
  insertTask,
  saveTask,
  takeNextTaskNumber,
  taskNotFound,
  type NewTaskRecord,
  type TaskListFilter,
} from './task.repository.js';
import {
  assertCancellable,
  assertStepAllowed,
  chooseApprovedHours,
  formatTaskNumber,
  secondsToHours,
  secondsWorked,
  type HoursChoice,
  type TaskStep,
} from './taskLifecycle.js';

const TASK_RESOURCE = 'task';

export type NewTaskDetails = Omit<NewTaskRecord, '_id' | 'taskNumber' | 'tlId'> & { tlId?: string };
export type TaskDetailChanges = Partial<Pick<TaskDoc, 'title' | 'description' | 'estimatedHours' | 'dueDate' | 'assignedDevId' | 'tlId'>>;
export type TaskListRequest = PageRequest & Omit<TaskListFilter, 'reach'>;

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
    title: task.title,
    description: task.description,
    status: task.status,
    assignedDevId: task.assignedDevId,
    tlId: task.tlId,
    dueDate: task.dueDate,
    estimatedHours: task.estimatedHours,
    actualHours: task.actualHours,
    approvedHours: task.approvedHours,
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

export async function listTasks(actor: Actor, scope: Scope, request: TaskListRequest) {
  const { tasks, total } = await findTasksPage({ ...request, reach: await reachForList(actor, scope) });
  const projects = await findProjectsByIds([...new Set(tasks.map((task) => task.projectId))]);
  const projectById = new Map(projects.map((project) => [project._id, project]));
  const rules = await fieldRulesFor(actor);
  return { scope, total, tasks: tasks.map((task) => toTaskView(task, projectById.get(task.projectId), rules)) };
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

export async function createTask(actor: Actor, scope: Scope, details: NewTaskDetails) {
  const project = await requireProject(details.projectId);
  await assertCanReachProject(actor, scope, project, 'read');
  if (project.status === 'completed') throw new ApiError(409, 'project_closed', 'This project is completed, so it takes no new tasks.');

  const tlId = details.tlId ?? actor.user._id;
  await assertPeopleExist({ assignedDevId: details.assignedDevId, tlId });
  assertIsProjectMember(project, details.assignedDevId, 'assignedDevId');
  const taskId = `t_${randomUUID()}`;
  // The new task has no shares yet, so this checks the caller's scope reaches the people it will belong to.
  await assertCanReachRecord(actor, scope, { ...historyRef(taskId), peopleIds: taskPeople({ ...details, tlId }, project) }, 'edit');

  const record: NewTaskRecord = { ...details, tlId, _id: taskId, taskNumber: await takeNextTaskNumber() };
  const task = await runInTransaction(async (session) => {
    const created = await insertTask(record, actor.user._id, session);
    await writeRecordHistory(historyRef(created._id), { action: 'created', actor, after: created }, session);
    await recordAudit({ action: 'task.created', ...taskAuditFields(actor, created) }, session);
    return created;
  });
  return toTaskView(task, project, await fieldRulesFor(actor));
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
  /** Fields the step sets, which need edit access when they're protected. */
  writes?: string[];
  buildUpdate: (context: TaskContext, now: Date) => UpdateQuery<TaskDoc>;
  /** A comment saved with the change, such as the reason for a revert. */
  comment?: string;
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
  assertMayWriteFields(rules, definition.writes ?? []);

  const update = definition.buildUpdate(context, new Date());
  const saved = await runInTransaction(async (session: ClientSession) => {
    const result = await saveTask(taskId, update, { actorId: actor.user._id, expectedVersion: definition.version ?? context.task.version, session });
    await writeRecordHistory(historyRef(taskId), { action: 'updated', actor, before: context.task, after: result }, session);
    await recordAudit({ action: definition.auditAction, ...taskAuditFields(actor, result) }, session);
    if (definition.comment) await insertComment(newComment(actor, taskId, definition.comment), session);
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
    check: async ({ task, project }) => {
      if (!fields.assignedDevId || fields.assignedDevId === task.assignedDevId) return;
      assertIsProjectMember(project, fields.assignedDevId, 'assignedDevId');
      if (task.resumedAt) throw new ApiError(409, 'timer_running', 'The assignee is working on this task. They need to pause it before it moves to someone else.');
      // The new assignee must also be inside the caller's reach, as on create.
      await assertCanReachRecord(actor, scope, { ...historyRef(taskId), peopleIds: [fields.assignedDevId] }, 'edit');
    },
    buildUpdate: () => ({ $set: fields }),
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

/** Stops the timer, records the hours worked, and sends the task for approval. */
export function completeTask(actor: Actor, scope: Scope, taskId: string) {
  return runStep(actor, scope, taskId, {
    step: 'complete',
    auditAction: 'task.completed',
    need: 'read',
    check: ({ task }) => assertIsAssignee(actor, task),
    buildUpdate: ({ task }, now) => {
      const seconds = secondsWorked(task, now);
      return {
        $set: { status: 'pending_approval', paused: false, accumulatedSeconds: seconds, actualHours: secondsToHours(seconds), completedAt: now },
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
      if (handover.qaId === task.assignedDevId) {
        throw new ApiError(422, 'validation_failed', 'Some fields are invalid.', [{ path: 'qaId', message: "can't be the person who did the work" }]);
      }
    },
    buildUpdate: () => ({
      $set: { status: 'qa_todo', qaId: handover.qaId, qaPaused: false, qaAccumulatedSeconds: 0, ...(handover.qaEstimatedHours !== undefined && { qaEstimatedHours: handover.qaEstimatedHours }) },
      $unset: { qaResumedAt: 1, qaActualHours: 1, qaApprovedHours: 1, qaCompletedAt: 1, qaResult: 1 },
    }),
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
      return { $set: { status: 'done', approvedHours, approvedBy: actor.user._id, approvedAt: now, ...(qaApprovedHours !== undefined && { qaApprovedHours }) } };
    },
  });
}

/** Sends the task back to the assignee, with the reason as a comment. A done task can be reverted when a bug turns up later. */
export function revertTask(actor: Actor, scope: Scope, taskId: string, reason: string) {
  return runStep(actor, scope, taskId, {
    step: 'revert',
    auditAction: 'task.reverted',
    need: 'edit',
    check: ({ task }) => assertNotOwnWork(actor, task),
    comment: reason,
    buildUpdate: () => ({
      $set: { status: 'reverted', paused: false },
      $inc: { revertCount: 1 },
      $unset: { resumedAt: 1, completedAt: 1, approvedHours: 1, qaApprovedHours: 1, approvedBy: 1, approvedAt: 1 },
    }),
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
