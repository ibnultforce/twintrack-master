import type { ClientSession } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { isDuplicateKeyError } from '../../../db.js';
import type { Month } from '../../../lib/period.js';
import { monthBounds } from '../../../lib/period.js';
import { IncentiveLedgerEntry, IncentiveSetting, ProjectIncentive, type IncentiveLedgerEntryDoc, type IncentiveSettingDoc } from '../models/incentive.js';
import { Project } from '../models/project.js';
import { Task } from '../models/task.js';

export type IncentiveSettingChanges = Pick<IncentiveSettingDoc, 'earnsMonthlyIncentive' | 'eligibleForProjectIncentives'> & { hourlyRate: number | null };

/** Settings for these people (null for everyone), or only for those who earn the monthly incentive. */
export function findIncentiveSettings(peopleIds: string[] | null, onlyEarners = false) {
  return IncentiveSetting.find({ ...(peopleIds && { _id: { $in: peopleIds } }), ...(onlyEarners && { earnsMonthlyIncentive: true }) }).lean();
}

export const findIncentiveSetting = (userId: string) => IncentiveSetting.findById(userId).lean();

export function saveIncentiveSetting(userId: string, changes: IncentiveSettingChanges, updatedBy: string) {
  const { hourlyRate, ...flags } = changes;
  return IncentiveSetting.findByIdAndUpdate(
    userId,
    { $set: { ...flags, updatedBy, ...(hourlyRate !== null && { hourlyRate }) }, ...(hourlyRate === null && { $unset: { hourlyRate: 1 } }) },
    { upsert: true, returnDocument: 'after' },
  ).lean();
}

/**
 * Approved hours of tasks finished in a month that each person led: as the task's TL, or as its project's lead. A task both
 * describe counts once. Deleted tasks don't count.
 */
export async function sumLedHours(userIds: string[], month: Month): Promise<Map<string, number>> {
  const { from, before } = monthBounds(month);
  const rows = await Task.aggregate<{ _id: string; hours: number }>([
    { $match: { status: 'done', completedAt: { $gte: from, $lt: before }, deletedAt: { $exists: false } } },
    { $lookup: { from: Project.collection.name, localField: 'projectId', foreignField: '_id', as: 'project', pipeline: [{ $project: { leadId: 1 } }] } },
    // Approved hours, so the approver's choice decides the money, and correcting the timer later can't change it.
    { $project: { approvedHours: { $ifNull: ['$approvedHours', 0] }, leaders: { $setUnion: [['$tlId'], '$project.leadId'] } } },
    { $unwind: '$leaders' },
    { $match: { leaders: { $in: userIds } } },
    { $group: { _id: '$leaders', hours: { $sum: '$approvedHours' } } },
  ]);
  return new Map(rows.map((row) => [row._id, row.hours]));
}

export function findLedgerEntries(filter: { userIds: string[] | null; month?: number; year?: number }) {
  return IncentiveLedgerEntry.find({
    ...(filter.userIds && { userId: { $in: filter.userIds } }),
    ...(filter.month && { month: filter.month }),
    ...(filter.year && { year: filter.year }),
  })
    .sort({ year: -1, month: -1, userId: 1 })
    .lean();
}

type LedgerFigures = Pick<IncentiveLedgerEntryDoc, 'completedHours' | 'hourlyRate' | 'totalPayout'>;

/**
 * Runs an upsert that skips paid entries. For a paid month the filter finds nothing, so the upsert tries to add a
 * second entry, which the unique index refuses. That refusal means "already paid", so it answers null.
 */
async function unlessPaid<Result>(write: () => Promise<Result>): Promise<Result | null> {
  try {
    return await write();
  } catch (error) {
    if (isDuplicateKeyError(error)) return null;
    throw error;
  }
}

/** Saves a month's figures, unless that month is already paid, which stays as it was paid. Returns null then. */
export function upsertUnpaidLedgerEntry(userId: string, month: Month, figures: LedgerFigures) {
  return unlessPaid(() => IncentiveLedgerEntry.findOneAndUpdate(
    { userId, ...month, disbursed: { $ne: true } },
    { $set: figures, $setOnInsert: { _id: `il_${randomUUID()}`, userId, ...month } },
    { upsert: true, returnDocument: 'after' },
  ).lean());
}

/** Records the payout with the figures it paid. Returns null when it was already paid. */
export function markLedgerEntryPaid(userId: string, month: Month, figures: LedgerFigures, paidBy: string) {
  return unlessPaid(() => IncentiveLedgerEntry.findOneAndUpdate(
    { userId, ...month, disbursed: { $ne: true } },
    { $set: { ...figures, disbursed: true, disbursedAt: new Date(), disbursedBy: paidBy }, $setOnInsert: { _id: `il_${randomUUID()}`, userId, ...month } },
    { upsert: true, returnDocument: 'after' },
  ).lean());
}

/** Each person's unpaid monthly incentive saved for a month, which payroll pays with their salary. */
export async function findUnpaidLedgerEntries(userIds: string[], month: Month): Promise<Map<string, IncentiveLedgerEntryDoc>> {
  const entries = await IncentiveLedgerEntry.find({ userId: { $in: userIds }, month: month.month, year: month.year, disbursed: false }).lean();
  return new Map(entries.map((entry) => [entry.userId, entry]));
}

/** Marks a monthly incentive paid when the payroll run that included it pays the person. Returns whether it was unpaid. */
export async function markLedgerEntryPaidByPayroll(userId: string, month: Month, paidBy: string, session: ClientSession): Promise<boolean> {
  const result = await IncentiveLedgerEntry.updateOne(
    { userId, month: month.month, year: month.year, disbursed: false },
    { $set: { disbursed: true, disbursedAt: new Date(), disbursedBy: paidBy } },
    { session },
  );
  return result.modifiedCount === 1;
}

export const findProjectIncentives = (projectId: string) => ProjectIncentive.find({ projectId }).lean();

export function saveProjectIncentive(projectId: string, userId: string, grant: { enabled: boolean; amount: number | null; notes: string | null }, grantedBy: string) {
  const toUnset = { ...(grant.amount === null && { amount: 1 }), ...(grant.notes === null && { notes: 1 }) };
  return ProjectIncentive.findOneAndUpdate(
    { projectId, userId },
    {
      $set: { enabled: grant.enabled, grantedBy, ...(grant.amount !== null && { amount: grant.amount }), ...(grant.notes !== null && { notes: grant.notes }) },
      ...(Object.keys(toUnset).length > 0 && { $unset: toUnset }),
      $setOnInsert: { _id: `pi_${randomUUID()}` },
    },
    { upsert: true, returnDocument: 'after' },
  ).lean();
}
