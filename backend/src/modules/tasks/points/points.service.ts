import { randomUUID } from 'node:crypto';
import { ApiError } from '../../../lib/errors.js';
import type { PageRequest } from '../../../lib/query.js';
import type { Actor } from '../../master/access/caller.js';
import { peopleInScope } from '../../master/access/scope.js';
import type { Scope } from '../../master/moduleRegistry/manifest.js';
import type { PointsReason } from '../models/pointsEntry.js';
import type { TaskDoc } from '../models/task.js';
import { findTasksByIds } from '../task/task.repository.js';
import { formatTaskNumber } from '../task/taskLifecycle.js';
import { findPeopleNames } from '../tasksModule.js';
import { findPointsEntriesOf, sumPointsByPerson, type NewPointsEntry } from './points.repository.js';

/** An entry for the points a task earned or lost, ready to save in the task's own transaction. */
export const pointsEntryFor = (task: Pick<TaskDoc, '_id' | 'projectId'>, userId: string, points: number, reason: PointsReason, actor: Actor): NewPointsEntry => ({
  _id: `pe_${randomUUID()}`,
  userId,
  taskId: task._id,
  projectId: task.projectId,
  points,
  reason,
  createdBy: actor.user._id,
});

/** Each person's points within the caller's scope, highest first. `since` limits it to a period, such as a review cycle. */
export async function listPointsTotals(actor: Actor, scope: Scope, request: PageRequest & { since?: Date }) {
  const { since, ...page } = request;
  const { people, total } = await sumPointsByPerson(await peopleInScope(actor.user._id, scope), since, page);
  const names = await findPeopleNames(people.map((person) => person.userId));
  return { scope, total, people: people.map((person) => ({ ...person, name: names.get(person.userId) })) };
}

/** One person's points and where they came from, newest first. */
export async function getPersonPoints(actor: Actor, scope: Scope, userId: string, request: PageRequest & { since?: Date }) {
  const reached = await peopleInScope(actor.user._id, scope);
  if (reached && !reached.includes(userId)) throw new ApiError(403, 'out_of_scope', 'This person is outside what your access reaches.');

  const { since, ...page } = request;
  const { entries, total, totalPoints } = await findPointsEntriesOf(userId, since, page);
  const tasks = new Map((await findTasksByIds([...new Set(entries.map((entry) => entry.taskId))])).map((task) => [task._id, task]));
  const names = await findPeopleNames([userId]);
  return {
    userId,
    name: names.get(userId),
    totalPoints,
    total,
    entries: entries.map((entry) => {
      const task = tasks.get(entry.taskId);
      return {
        id: entry._id,
        points: entry.points,
        reason: entry.reason,
        taskId: entry.taskId,
        taskNumber: task ? formatTaskNumber(task.taskNumber) : undefined,
        taskTitle: task?.title,
        createdAt: entry.createdAt,
      };
    }),
  };
}
