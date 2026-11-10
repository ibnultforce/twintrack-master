import { ApiError } from '../../../lib/errors.js';
import { CLOSED_TASK_STATUSES, type TaskStatus } from '../models/task.js';

/**
 * The rules of a task's life that need no database: which status each step starts from, how the timers count,
 * and which hours an approver may choose. The service applies them and saves the result.
 */

export const TASK_NUMBER_DIGITS = 5;

/** The number people see, such as T-00102. */
export const formatTaskNumber = (taskNumber: number) => `T-${String(taskNumber).padStart(TASK_NUMBER_DIGITS, '0')}`;

/** The statuses each step may start from. */
export const STEP_STARTS_FROM = {
  start: ['todo', 'reverted', 'in_progress'],
  pause: ['in_progress'],
  complete: ['in_progress'],
  qaHandover: ['pending_approval'],
  qaStart: ['qa_todo', 'qa_in_progress'],
  qaPause: ['qa_in_progress'],
  qaComplete: ['qa_in_progress'],
  approve: ['pending_approval'],
  revert: ['pending_approval', 'done'],
  edit: ['todo', 'in_progress', 'pending_approval', 'qa_todo', 'qa_in_progress', 'reverted'],
} as const satisfies Record<string, readonly TaskStatus[]>;

export type TaskStep = keyof typeof STEP_STARTS_FROM;

export function assertStepAllowed(step: TaskStep, status: TaskStatus): void {
  if (!(STEP_STARTS_FROM[step] as readonly TaskStatus[]).includes(status)) {
    throw new ApiError(409, 'invalid_status', `A task that is ${status.replaceAll('_', ' ')} can't do that.`);
  }
}

/** Any open task can be cancelled. A done task can't, because its hours were already approved. */
export function assertCancellable(status: TaskStatus): void {
  if (CLOSED_TASK_STATUSES.includes(status)) throw new ApiError(409, 'invalid_status', `A task that is ${status} can't be cancelled.`);
}

const SECONDS_PER_HOUR = 3600;
const HOUR_DECIMALS = 100;

/** Seconds banked so far, plus the time since the timer was last resumed while it runs. */
export function secondsWorked(timer: { accumulatedSeconds: number; resumedAt?: Date }, now: Date): number {
  const runningSeconds = timer.resumedAt ? Math.max(0, Math.floor((now.getTime() - timer.resumedAt.getTime()) / 1000)) : 0;
  return timer.accumulatedSeconds + runningSeconds;
}

/** Hours to two decimal places, which is how hours are stored and shown. */
export const secondsToHours = (seconds: number) => Math.round((seconds / SECONDS_PER_HOUR) * HOUR_DECIMALS) / HOUR_DECIMALS;

export const HOURS_BASES = ['estimated', 'actual', 'custom'] as const;
export type HoursBasis = (typeof HOURS_BASES)[number];

export interface HoursChoice {
  basis: HoursBasis;
  /** Needed when the basis is custom. */
  customHours?: number;
}

/**
 * The hours an approver settles on. Custom hours must be above zero, and no more than the larger of the
 * estimate and the time actually worked, so approving can't add hours nobody planned or worked.
 */
export function chooseApprovedHours(choice: HoursChoice, hours: { estimated: number; actual: number }, field: string): number {
  if (choice.basis === 'estimated') return hours.estimated;
  if (choice.basis === 'actual') return hours.actual;

  const ceiling = Math.max(hours.estimated, hours.actual);
  const custom = choice.customHours;
  if (custom === undefined || custom <= 0 || custom > ceiling) {
    throw new ApiError(422, 'validation_failed', 'Some fields are invalid.', [
      { path: `${field}.customHours`, message: `must be above zero and no more than ${ceiling}` },
    ]);
  }
  return custom;
}
