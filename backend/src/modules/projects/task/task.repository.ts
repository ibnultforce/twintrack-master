import type { ClientSession, UpdateQuery } from 'mongoose';
import { ApiError } from '../../../lib/errors.js';
import { escapeRegex, pageOffset, type PageRequest } from '../../../lib/query.js';
import { changeRecord } from '../../../lib/records/recordWrites.js';
import { CLOSED_TASK_STATUSES, Task, type TaskDoc, type TaskStatus } from '../models/task.js';
import { TaskComment, type TaskCommentDoc } from '../models/taskComment.js';
import { TaskCounter } from '../models/taskCounter.js';

const TASK_COUNTER_ID = 'task';

export type NewTaskRecord = Pick<TaskDoc, '_id' | 'taskNumber' | 'projectId' | 'kind' | 'title' | 'description' | 'assignedDevId' | 'tlId' | 'estimatedHours' | 'dueDate' | 'billable' | 'pointValue' | 'referencedTaskIds'>;
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
  tlId?: string;
  /** Past the due date and not done or cancelled. */
  overdue?: boolean;
  /** Part of the title, or a task number such as T-00102, 00102 or 102. */
  search?: string;
  /** Completed on or after this moment. */
  completedFrom?: Date;
  /** Completed before this moment. */
  completedBefore?: Date;
  /** Only tasks in these projects, such as the ones the caller leads. */
  projectIds?: string[];
  flagged?: boolean;
  billable?: boolean;
}

export const TASK_SORT_FIELDS = ['createdAt', 'dueDate', 'estimatedHours', 'actualHours', 'variance', 'pointValue'] as const;
export type TaskSortField = (typeof TASK_SORT_FIELDS)[number];

export interface TaskSort {
  sortBy: TaskSortField;
  sortDirection: 'asc' | 'desc';
}

/** The number in "T-00102", "00102" or "102", or null when the search isn't a task number. */
export function parseTaskNumber(search: string): number | null {
  const digits = search.trim().replace(/^t-?/i, '');
  return /^\d{1,9}$/.test(digits) ? Number(digits) : null;
}

/** Hands out the next task number. It runs outside any transaction, so a failed create leaves a gap rather than a reuse. */
export async function takeNextTaskNumber(): Promise<number> {
  const counter = await TaskCounter.findOneAndUpdate({ _id: TASK_COUNTER_ID }, { $inc: { lastNumber: 1 } }, { upsert: true, returnDocument: 'after' }).lean();
  if (!counter) throw new Error('The task counter returned nothing.');
  return counter.lastNumber;
}

function searchFilter(search: string | undefined) {
  if (!search?.trim()) return [];
  const taskNumber = parseTaskNumber(search);
  const titleMatch = { title: { $regex: escapeRegex(search.trim()), $options: 'i' } };
  return [{ $or: [titleMatch, ...(taskNumber === null ? [] : [{ taskNumber }])] }];
}

function toQueryFilter(filter: TaskListFilter) {
  const { reach, projectId, status, assignedDevId, tlId, overdue, search, completedFrom, completedBefore, projectIds, flagged, billable } = filter;
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
  const completedFilter = (completedFrom || completedBefore) && {
    completedAt: { ...(completedFrom && { $gte: completedFrom }), ...(completedBefore && { $lt: completedBefore }) },
  };
  // Conditions that could clash on one field, such as overdue and a status, each go in $and so all of them hold.
  const conditions = [...(overdueFilter ? [overdueFilter] : []), ...searchFilter(search), ...(projectIds ? [{ projectId: { $in: projectIds } }] : [])];
  return {
    ...reachFilter,
    ...(projectId && { projectId }),
    ...(assignedDevId && { assignedDevId }),
    ...(tlId && { tlId }),
    ...(status && { status }),
    // Tasks saved before these fields existed have neither, and read as not flagged and billable.
    ...(flagged !== undefined && { flagged: flagged ? true : { $ne: true } }),
    ...(billable !== undefined && { billable: billable ? { $ne: false } : false }),
    ...completedFilter,
    ...(conditions.length > 0 && { $and: conditions }),
  };
}

/**
 * Aggregations skip the soft-delete hook that queries get, so they hide deleted tasks here. Variance, the hours
 * worked beyond the estimate, only exists once a task has actual hours.
 */
const aggregateBase = (filter: TaskListFilter) => [
  { $match: { ...toQueryFilter(filter), deletedAt: { $exists: false } } },
  { $addFields: { variance: { $cond: [{ $ifNull: ['$actualHours', false] }, { $subtract: ['$actualHours', '$estimatedHours'] }, null] } } },
];

export async function findTasksPage({ page, pageSize, sortBy = 'createdAt', sortDirection = 'desc', ...filter }: PageRequest & TaskListFilter & Partial<TaskSort>) {
  const direction = sortDirection === 'asc' ? 1 : -1;
  const [tasks, total] = await Promise.all([
    Task.aggregate<TaskDoc>([
      ...aggregateBase(filter),
      // The task number breaks ties, so pages never shuffle between requests.
      { $sort: { [sortBy]: direction, taskNumber: -1 } },
      { $skip: pageOffset({ page, pageSize }) },
      { $limit: pageSize },
      { $project: { variance: 0 } },
    ]),
    Task.countDocuments(toQueryFilter(filter)),
  ]);
  return { tasks, total };
}

export interface TaskTotals {
  taskCount: number;
  estimatedHours: number;
  actualHours: number;
  /** Actual minus estimated, over the tasks that have actual hours. */
  varianceHours: number;
  pointValue: number;
}

export async function sumTasks(filter: TaskListFilter): Promise<TaskTotals> {
  const [totals] = await Task.aggregate<TaskTotals>([
    ...aggregateBase(filter),
    {
      $group: {
        _id: null,
        taskCount: { $sum: 1 },
        estimatedHours: { $sum: '$estimatedHours' },
        actualHours: { $sum: { $ifNull: ['$actualHours', 0] } },
        varianceHours: { $sum: { $ifNull: ['$variance', 0] } },
        pointValue: { $sum: '$pointValue' },
      },
    },
    { $project: { _id: 0 } },
  ]);
  return totals ?? { taskCount: 0, estimatedHours: 0, actualHours: 0, varianceHours: 0, pointValue: 0 };
}

/** Every task a filter matches, newest first, up to a cap, for exports. */
export function findTasksForExport(filter: TaskListFilter, limit: number) {
  return Task.find(toQueryFilter(filter)).sort({ taskNumber: -1 }).limit(limit).lean();
}

/** A short list for picking a task by title or number. */
export function searchTaskSummaries(filter: TaskListFilter, limit: number) {
  return Task.find(toQueryFilter(filter)).sort({ taskNumber: -1 }).limit(limit).select('taskNumber title status projectId').lean();
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

export interface ProjectHours {
  projectId: string;
  completedHours: number;
  openTaskCount: number;
}

/** Per project: hours of done tasks, and how many tasks are still open. Deleted tasks don't count. */
export function sumHoursByProject(projectIds: string[]): Promise<ProjectHours[]> {
  return Task.aggregate<ProjectHours>([
    { $match: { projectId: { $in: projectIds }, deletedAt: { $exists: false } } },
    {
      $group: {
        _id: '$projectId',
        completedHours: { $sum: { $cond: [{ $eq: ['$status', 'done'] }, { $ifNull: ['$actualHours', 0] }, 0] } },
        openTaskCount: { $sum: { $cond: [{ $in: ['$status', CLOSED_TASK_STATUSES] }, 0, 1] } },
      },
    },
    { $project: { _id: 0, projectId: '$_id', completedHours: 1, openTaskCount: 1 } },
  ]);
}

export interface LeadHours {
  projectId: string;
  tlId: string;
  hours: number;
}

/** Hours of tasks done in a period, per project and per the task's TL, which incentives pay on. */
export function sumDoneHoursByLead(projectIds: string[], from: Date, before: Date): Promise<LeadHours[]> {
  return Task.aggregate<LeadHours>([
    { $match: { projectId: { $in: projectIds }, status: 'done', completedAt: { $gte: from, $lt: before }, deletedAt: { $exists: false } } },
    // Approved hours, as incentives pay: the approver's choice, not the raw timer.
    { $group: { _id: { projectId: '$projectId', tlId: '$tlId' }, hours: { $sum: { $ifNull: ['$approvedHours', 0] } } } },
    { $project: { _id: 0, projectId: '$_id.projectId', tlId: '$_id.tlId', hours: 1 } },
  ]);
}

/** The few fields the roster needs from every task in these projects. */
export function findRosterTasks(projectIds: string[]) {
  return Task.find({ projectId: { $in: projectIds } }).select('projectId tlId assignedDevId status estimatedHours actualHours completedAt').lean();
}

export const findTaskByNumber = (taskNumber: number) => Task.findOne({ taskNumber }).lean();

export interface PersonWorkload {
  userId: string;
  openTasks: number;
  openEstimatedHours: number;
  openQaTasks: number;
  openQaEstimatedHours: number;
}

/** Open work per person across all projects: tasks they're doing, and QA passes waiting on them. */
/** Open work for each person, counting only tasks the filter matches, such as the ones a caller's scope reaches. */
export async function sumOpenWork(userIds: string[], filter: TaskListFilter): Promise<Map<string, PersonWorkload>> {
  const inFilter = toQueryFilter(filter);
  const [work, qa] = await Promise.all([
    Task.aggregate<{ _id: string; count: number; hours: number }>([
      { $match: { $and: [inFilter, { assignedDevId: { $in: userIds }, status: { $in: ['todo', 'in_progress', 'reverted'] }, deletedAt: { $exists: false } }] } },
      { $group: { _id: '$assignedDevId', count: { $sum: 1 }, hours: { $sum: '$estimatedHours' } } },
    ]),
    Task.aggregate<{ _id: string; count: number; hours: number }>([
      { $match: { $and: [inFilter, { qaId: { $in: userIds }, status: { $in: ['qa_todo', 'qa_in_progress'] }, deletedAt: { $exists: false } }] } },
      { $group: { _id: '$qaId', count: { $sum: 1 }, hours: { $sum: { $ifNull: ['$qaEstimatedHours', 0] } } } },
    ]),
  ]);
  return new Map(
    userIds.map((userId) => {
      const own = work.find((row) => row._id === userId);
      const testing = qa.find((row) => row._id === userId);
      return [userId, { userId, openTasks: own?.count ?? 0, openEstimatedHours: own?.hours ?? 0, openQaTasks: testing?.count ?? 0, openQaEstimatedHours: testing?.hours ?? 0 }];
    }),
  );
}
