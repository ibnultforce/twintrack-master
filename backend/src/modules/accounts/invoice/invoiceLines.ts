import { ApiError } from '../../../lib/errors.js';
import { findBillableProjects, findClientProjects, findCompletedTasks, findTasksByIds, type BillableTask } from '../../projects/billing/taskBilling.js';
import type { ClientBilling } from '../clientAccount/clientAccount.service.js';
import type { InvoiceLine } from '../models/invoice.js';

/*
 * Turning Project management work into invoice lines. A task is billed on its estimate, never the hours worked, so a
 * client's price doesn't change with how long the work took: estimated hours × the client's hourly rate.
 */

/** A line typed by a person, such as a milestone payment. */
export interface ManualInvoiceItem {
  description: string;
  /** In the invoice's currency, minor units. */
  amount: number;
  milestone?: string;
}

const invalid = (path: string, message: string) => new ApiError(422, 'validation_failed', 'Some invoice details are invalid.', [{ path, message }]);

/** Hours × rate, rounded to the nearest cent: 1.5 hours at $45.00 is $67.50. */
export const amountForHours = (hours: number, hourlyRate: number) => Math.round(hours * hourlyRate);

/** A day after `to`, since the billing helpers take an end that is not included. */
const dayAfter = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) + 24 * 60 * 60 * 1000);

/** Finished, billable tasks on the client's projects in the period that no invoice has billed yet, with what each would bill. */
export async function findUnbilledTasks(billing: ClientBilling, from: string, to: string) {
  const projects = await findClientProjects(billing.clientId);
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  const tasks = await findCompletedTasks(projects.map((project) => project.id), new Date(`${from}T00:00:00Z`), dayAfter(to));
  return tasks
    .filter((task) => task.billable && !task.invoiceId)
    .map((task) => ({
      ...task,
      projectName: projectNames.get(task.projectId) ?? task.projectId,
      ...(billing.hourlyRate !== undefined && { amount: amountForHours(task.hours, billing.hourlyRate) }),
    }));
}

/**
 * Lines for the named tasks, after checking each is a finished, billable task of this client that no other invoice
 * has billed. `invoiceId` is the invoice being edited, whose own tasks are allowed.
 */
export async function linesForTasks(billing: ClientBilling, currency: string, taskIds: string[], invoiceId?: string): Promise<{ lines: InvoiceLine[]; tasks: BillableTask[] }> {
  if (taskIds.length === 0) return { lines: [], tasks: [] };
  if (billing.hourlyRate === undefined) throw invalid('taskIds', `${billing.clientName} has no hourly rate yet. Set one under Clients first.`);
  if (currency !== billing.currency) throw invalid('currency', `${billing.clientName}'s rate is in ${billing.currency}, so an invoice for tasks must be in ${billing.currency}`);
  const hourlyRate = billing.hourlyRate;

  const tasks = await findTasksByIds([...new Set(taskIds)]);
  const projects = new Map((await findBillableProjects([...new Set(tasks.map((task) => task.projectId))])).map((project) => [project.id, project]));
  const byId = new Map(tasks.map((task) => [task.id, task]));
  taskIds.forEach((taskId, index) => {
    const task = byId.get(taskId);
    const path = `taskIds.${index}`;
    if (!task || projects.get(task.projectId)?.clientId !== billing.clientId) throw invalid(path, `isn't a task on one of ${billing.clientName}'s projects`);
    if (task.status !== 'done') throw invalid(path, `${task.number} isn't finished`);
    if (!task.billable) throw invalid(path, `${task.number} isn't billable`);
    if (task.invoiceId && task.invoiceId !== invoiceId) throw invalid(path, `${task.number} is already on another invoice`);
  });
  const ordered = taskIds.map((taskId) => byId.get(taskId)).filter((task): task is BillableTask => Boolean(task));
  return {
    tasks: ordered,
    lines: ordered.map((task) => ({
      description: `${projects.get(task.projectId)?.name ?? 'Project'}: ${task.number} ${task.title}`,
      amount: amountForHours(task.hours, hourlyRate),
      taskId: task.id,
      hours: task.hours,
    })),
  };
}

export const linesForItems = (items: ManualInvoiceItem[]): InvoiceLine[] =>
  items.map((item) => ({ description: item.description, amount: item.amount, ...(item.milestone && { milestone: item.milestone }) }));
