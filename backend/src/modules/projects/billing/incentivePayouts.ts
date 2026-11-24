import type { ClientSession } from 'mongoose';
import { IncentiveLedgerEntry } from '../models/incentive.js';

/**
 * What Accounts may read and change in Project management to pay monthly incentives: the unpaid figures for a month,
 * and marking one paid when Accounts records the payout. Project management works the figures out; Accounts only pays
 * them, and an incentive marked paid never changes again, so it can be paid only once.
 */

export interface UnpaidIncentive {
  userId: string;
  /** 1 to 12. */
  month: number;
  year: number;
  completedHours: number;
  /** Taka per hour, as Project management keeps it. */
  hourlyRate: number;
  /** Taka, as Project management keeps it; Accounts converts to paisa. */
  totalPayout: number;
}

/** Unpaid monthly incentives saved for a month, above zero, by person. */
export async function findUnpaidIncentives(year: number, month: number): Promise<UnpaidIncentive[]> {
  const entries = await IncentiveLedgerEntry.find({ year, month, disbursed: { $ne: true }, totalPayout: { $gt: 0 } }).sort({ userId: 1 }).lean();
  return entries.map((entry) => ({ userId: entry.userId, month: entry.month, year: entry.year, completedHours: entry.completedHours, hourlyRate: entry.hourlyRate, totalPayout: entry.totalPayout }));
}

/** Marks a person's incentive for the month paid, inside Accounts' transaction. Returns false when it was already paid. */
export async function markIncentivePaid(userId: string, year: number, month: number, paidBy: string, session: ClientSession): Promise<boolean> {
  const result = await IncentiveLedgerEntry.updateOne({ userId, year, month, disbursed: { $ne: true } }, { $set: { disbursed: true, disbursedAt: new Date(), disbursedBy: paidBy } }, { session });
  return result.modifiedCount === 1;
}
