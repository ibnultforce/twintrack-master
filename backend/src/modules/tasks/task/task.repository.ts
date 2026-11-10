import type { ClientSession, UpdateQuery } from 'mongoose';
import { ApiError } from '../../../lib/errors.js';
import { pageOffset, type PageRequest } from '../../../lib/query.js';
import { changeRecord } from '../../../lib/records/recordWrites.js';
import { CLOSED_TASK_STATUSES, Task, type TaskDoc, type TaskStatus } from '../models/task.js';
import { TaskComment, type TaskCommentDoc } from '../models/taskComment.js';
import { TaskCounter } from '../models/taskCounter.js';

const TASK_COUNTER_ID = 'task';

export type NewTaskRecord = Pick<TaskDoc, '_id' | 'taskNumber' | 'projectId' | 'title' | 'description' | 'assignedDevId' | 'tlId' | 'estimatedHours' | 'dueDate'>;
export type NewCommentRecord = Pick<TaskCommentDoc, '_id' | 'taskId' | 'authorId' | 'authorName' | 'body'>;

export const taskNotFound = () => new ApiError(404, 'unknown_task', 'No such task.');

interface WriteContext {
  actorId: string;
  expectedVersion?: number;
  session: ClientSession;
}

/** Who a list reaches. Missing means every task. */
export interface TaskReach {
  peopleIds: string[];
  /** Projects led by someone the scope reaches: their tasks are reached too. */
  projectIds: string[];
  sharedIds: string[];
}

export interface TaskListFilter {
  reach?: TaskReach;
  projectId?: string;
  status?: TaskStatus;
  assignedDevId?: string;
  /** Past the due date and not done or cancelled. */
  overdue?: boolean;
}

/** Hands out the next task number. It runs outside any transaction, so a failed create leaves a gap rather than a reuse. */
export async function takeNextTaskNumber(): Promise<number> {
  const counter = await TaskCounter.findOneAndUpdate({ _id: TASK_COUNTER_ID }, { $inc: { lastNumber: 1 } }, { upsert: true, returnDocument: 'after' }).lean();
  if (!counter) throw new Error('The task counter returned nothing.');
  return counter.lastNumber;
}

function toQueryFilter({ reach, projectId, status, assignedDevId, overdue }: TaskListFilter) {
  const reachFilter = reach && {
    $or: [
      { assignedDevId: { $in: reach.peopleIds } },
      { tlId: { $in: reach.peopleIds } },
      { qaId: { $in: reach.peopleIds } },
      { projectId: { $in: reach.projectIds } },
      { _id: { $in: reach.sharedIds } },
    ],
  };
  const overdueFilter = overdue && { dueDate: { $lt: new Date() }, status: { $nin: CLOSED_TASK_STATUSES } };
  return {
    ...reachFilter,
    ...(projectId && { projectId }),
    ...(assignedDevId && { assignedDevId }),
    ...(status && { status }),
    // Overdue and a status filter both set status, so both must hold.
    ...(overdueFilter && { $and: [overdueFilter] }),
  };
}

export async function findTasksPage({ page, pageSize, ...filter }: PageRequest & TaskListFilter) {
  const query = toQueryFilter(filter);
  const [tasks, total] = await Promise.all([
    Task.find(query).sort({ taskNumber: -1 }).skip(pageOffset({ page, pageSize })).limit(pageSize).lean(),
    Task.countDocuments(query),
  ]);
  return { tasks, total };
}

export const findTaskById = (taskId: string) => Task.findById(taskId).lean();

export function findTasksByIds(taskIds: string[]) {
  return Task.find({ _id: { $in: taskIds } }).select('taskNumber title status').lean();
}

/** The tasks that point to this one. */
export function findTasksReferencing(taskId: string) {
  return Task.find({ referencedTaskIds: taskId }).select('taskNumber title status').lean();
}

/** Open tasks in a project given to any of these people, which keep them from being removed from it. */
export function countOpenTasksAssignedTo(projectId: string, peopleIds: string[]) {
  return Task.countDocuments({ projectId, status: { $nin: CLOSED_TASK_STATUSES }, $or: [{ assignedDevId: { $in: peopleIds } }, { qaId: { $in: peopleIds } }] });
}

export async function insertTask(record: NewTaskRecord, createdBy: string, session: ClientSession): Promise<TaskDoc> {
  const [created] = await Task.create([{ ...record, createdBy, updatedBy: createdBy }], { session });
  if (!created) throw new Error('Creating the task returned nothing.');
  return created.toObject();
}

/** Saves one change to a task. Steps pass the version they read, so two steps racing on one task can't both apply. */
export function saveTask(taskId: string, update: UpdateQuery<TaskDoc>, context: WriteContext) {
  return changeRecord(Task, taskId, update, context, taskNotFound);
}

export async function insertComment(record: NewCommentRecord, session: ClientSession): Promise<TaskCommentDoc> {
  const [created] = await TaskComment.create([record], { session });
  if (!created) throw new Error('Creating the comment returned nothing.');
  return created.toObject();
}

export async function findCommentsPage(taskId: string, page: PageRequest) {
  const [comments, total] = await Promise.all([
    TaskComment.find({ taskId }).sort({ createdAt: 1, _id: 1 }).skip(pageOffset(page)).limit(page.pageSize).lean(),
    TaskComment.countDocuments({ taskId }),
  ]);
  return { comments, total };
}
