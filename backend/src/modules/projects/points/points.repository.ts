import type { ClientSession } from 'mongoose';
import { pageOffset, type PageRequest } from '../../../lib/query.js';
import { PointsEntry, type PointsEntryDoc } from '../models/pointsEntry.js';

export type NewPointsEntry = Omit<PointsEntryDoc, 'createdAt'>;

export async function insertPointsEntries(entries: NewPointsEntry[], session: ClientSession): Promise<void> {
  if (entries.length > 0) await PointsEntry.insertMany(entries, { session });
}

export interface PersonPoints {
  userId: string;
  /** Never below zero, however many reverts a person has had. */
  totalPoints: number;
  lastChangedAt: Date;
}

/** Each person's total, among these people (null for everyone), counting entries from `since` when given. */
export async function sumPointsByPerson(peopleIds: string[] | null, since: Date | undefined, page: PageRequest) {
  const match = { ...(peopleIds && { userId: { $in: peopleIds } }), ...(since && { createdAt: { $gte: since } }) };
  const [result] = await PointsEntry.aggregate<{ people: PersonPoints[]; total: { count: number }[] }>([
    { $match: match },
    { $group: { _id: '$userId', totalPoints: { $sum: '$points' }, lastChangedAt: { $max: '$createdAt' } } },
    { $project: { _id: 0, userId: '$_id', totalPoints: { $max: [0, '$totalPoints'] }, lastChangedAt: 1 } },
    { $sort: { totalPoints: -1, userId: 1 } },
    { $facet: { people: [{ $skip: pageOffset(page) }, { $limit: page.pageSize }], total: [{ $count: 'count' }] } },
  ]);
  return { people: result?.people ?? [], total: result?.total[0]?.count ?? 0 };
}

export async function findPointsEntriesOf(userId: string, since: Date | undefined, page: PageRequest) {
  const filter = { userId, ...(since && { createdAt: { $gte: since } }) };
  const [entries, total, sums] = await Promise.all([
    PointsEntry.find(filter).sort({ createdAt: -1, _id: 1 }).skip(pageOffset(page)).limit(page.pageSize).lean(),
    PointsEntry.countDocuments(filter),
    PointsEntry.aggregate<{ total: number }>([{ $match: filter }, { $group: { _id: null, total: { $sum: '$points' } } }]),
  ]);
  return { entries, total, totalPoints: Math.max(0, sums[0]?.total ?? 0) };
}

/** All-time totals for these people, for summaries such as the roster. Missing means no points yet. */
export async function sumPointsOf(userIds: string[]): Promise<Map<string, number>> {
  const sums = await PointsEntry.aggregate<{ _id: string; total: number }>([
    { $match: { userId: { $in: userIds } } },
    { $group: { _id: '$userId', total: { $sum: '$points' } } },
  ]);
  return new Map(sums.map((sum) => [sum._id, Math.max(0, sum.total)]));
}
