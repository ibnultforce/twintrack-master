import type { Request } from 'express';
import type { Scope } from '../moduleRegistry/manifest.js';
import { User } from '../models/user.js';
import { findOrgRoleIdsBelow } from '../orgRoles/orgRoles.repository.js';

/** Set by the permission check on private routes: how far this person's permission reaches. */
export function getPermissionScope(req: Request): Scope {
  if (!req.permissionScope) throw new Error(`${req.method} ${req.path} used the scope without a permission check.`);
  return req.permissionScope;
}

/**
 * The ids of the people a scope reaches from this person. Null means everyone.
 * A team is the person, their direct reports, and everyone in the org roles below theirs. People who share
 * their org role are peers, so they aren't included.
 */
export async function peopleInScope(userId: string, scope: Scope): Promise<string[] | null> {
  if (scope === 'all') return null;
  if (scope === 'own') return [userId];

  const person = await User.findById(userId).select('orgRoleId').lean();
  const orgRoleIdsBelow = person?.orgRoleId ? await findOrgRoleIdsBelow(person.orgRoleId) : [];
  const teamIds: string[] = await User.find({
    _id: { $ne: userId },
    $or: [{ managerId: userId }, ...(orgRoleIdsBelow.length > 0 ? [{ orgRoleId: { $in: orgRoleIdsBelow } }] : [])],
  }).distinct('_id');
  return [userId, ...teamIds];
}
