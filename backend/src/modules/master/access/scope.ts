import type { Request } from 'express';
import type { Scope } from '../moduleRegistry/manifest.js';
import { User } from '../models/user.js';

/** Set by the permission check on private routes: how far this person's permission reaches. */
export function getPermissionScope(req: Request): Scope {
  if (!req.permissionScope) throw new Error(`${req.method} ${req.path} used the scope without a permission check.`);
  return req.permissionScope;
}

/**
 * The ids of the people a scope reaches from this person. Null means everyone.
 * A team is the person and everyone who reports to them, directly or through others: the reporting tree below
 * them, followed through each person's manager. Two people in the same org role lead separate teams, so a
 * project manager reaches only the people in their own reporting line, never another project manager's.
 */
export async function peopleInScope(userId: string, scope: Scope): Promise<string[] | null> {
  if (scope === 'all') return null;
  if (scope === 'own') return [userId];
  return [userId, ...(await findEveryoneReportingTo(userId))];
}

/** Everyone below this person in the reporting tree, at any depth. A loop in the manager links can't repeat anyone. */
async function findEveryoneReportingTo(userId: string): Promise<string[]> {
  const [result] = await User.aggregate<{ reports: { _id: string }[] }>([
    { $match: { _id: userId } },
    { $graphLookup: { from: User.collection.name, startWith: '$_id', connectFromField: '_id', connectToField: 'managerId', as: 'reports' } },
    { $project: { reports: { _id: 1 } } },
  ]);
  return (result?.reports ?? []).map((report) => report._id).filter((reportId) => reportId !== userId);
}
