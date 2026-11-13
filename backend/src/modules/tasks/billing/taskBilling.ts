import type { ClientSession } from 'mongoose';
import { Project } from '../models/project.js';
import { Task } from '../models/task.js';
import { formatTaskNumber } from '../task/taskLifecycle.js';

/**
 * What Accounts may read and change in Tasks to bill clients: finished or logged work, by project, and which invoice
 * billed it. Invoices bill a task's estimate, never the hours worked, as the old app did, so a client's price doesn't
 * change with how long the work took. Nothing else in Tasks is written from Accounts.
 */

export interface BillableTask {
  id: string;
  number: string;
  projectId: string;
  title: string;
  status: string;
  hours: number;
  billable: boolean;
  /** When it finished, or when it was created for work billed as it's logged. */
  date: Date;
  invoiceId?: string;
}

export interface BillableProject {
  id: string;
  name: string;
  clientId?: string;
}

const taskFields = 'taskNumber projectId title status estimatedHours billable completedAt createdAt invoiceId';

type StoredTask = { _id: string; taskNumber: number; projectId: string; title: string; status: string; estimatedHours: number; billable?: boolean; completedAt?: Date; createdAt: Date; invoiceId?: string };

const toBillableTask = (task: StoredTask, date: Date): BillableTask => ({
  id: task._id,
  number: formatTaskNumber(task.taskNumber),
  projectId: task.projectId,
  title: task.title,
  status: task.status,
  hours: task.estimatedHours,
  // Tasks saved before billing existed count as billable, as they do in Tasks.
  billable: task.billable !== false,
  date,
  ...(task.invoiceId && { invoiceId: task.invoiceId }),
});

export async function findBillableProjects(projectIds: string[]): Promise<BillableProject[]> {
  const projects = await Project.find({ _id: { $in: projectIds } }).select('name clientId').lean();
  return projects.map((project) => ({ id: project._id, name: project.name, ...(project.clientId && { clientId: project.clientId }) }));
}

export async function findClientProjects(clientId: string): Promise<BillableProject[]> {
  const projects = await Project.find({ clientId }).select('name clientId').lean();
  return projects.map((project) => ({ id: project._id, name: project.name, clientId }));
}

/** Tasks finished in the period, oldest first. Already-invoiced ones are included, so an invoice can be reissued. */
export async function findCompletedTasks(projectIds: string[], from: Date, before: Date): Promise<BillableTask[]> {
  const tasks = await Task.find({ projectId: { $in: projectIds }, status: 'done', completedAt: { $gte: from, $lt: before } })
    .sort({ completedAt: 1, _id: 1 })
    .select(taskFields)
    .lean<StoredTask[]>();
  return tasks.map((task) => toBillableTask(task, task.completedAt ?? task.createdAt));
}

/** Tasks created in the period, at any status except cancelled, for billing work as it's logged. */
export async function findCreatedTasks(projectIds: string[], from: Date, before: Date): Promise<BillableTask[]> {
  const tasks = await Task.find({ projectId: { $in: projectIds }, status: { $ne: 'cancelled' }, createdAt: { $gte: from, $lt: before } })
    .sort({ createdAt: 1, _id: 1 })
    .select(taskFields)
    .lean<StoredTask[]>();
  return tasks.map((task) => toBillableTask(task, task.createdAt));
}

export async function markTasksInvoiced(taskIds: string[], invoiceId: string, session: ClientSession): Promise<void> {
  if (taskIds.length > 0) await Task.updateMany({ _id: { $in: taskIds } }, { $set: { invoiceId } }, { session });
}

/** Undoes an invoice's billing, when a draft invoice is deleted, so its tasks count as unbilled again. */
export async function releaseInvoicedTasks(invoiceId: string, session: ClientSession): Promise<void> {
  await Task.updateMany({ invoiceId }, { $unset: { invoiceId: 1 } }, { session });
}

export interface UnbilledProjectHours {
  projectId: string;
  projectName: string;
  clientId?: string;
  hours: number;
}

/** Billable estimated hours of finished tasks no invoice has billed yet, by project, most first. */
export async function sumUnbilledHours(): Promise<UnbilledProjectHours[]> {
  const rows = await Task.aggregate<{ _id: string; hours: number }>([
    { $match: { status: 'done', invoiceId: { $exists: false }, billable: { $ne: false }, deletedAt: { $exists: false } } },
    { $group: { _id: '$projectId', hours: { $sum: '$estimatedHours' } } },
  ]);
  const projects = new Map((await findBillableProjects(rows.map((row) => row._id))).map((project) => [project.id, project]));
  return rows
    .map((row) => ({ projectId: row._id, projectName: projects.get(row._id)?.name ?? row._id, clientId: projects.get(row._id)?.clientId, hours: row.hours }))
    .sort((first, second) => second.hours - first.hours);
}
