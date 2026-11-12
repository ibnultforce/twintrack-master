import type { Actor } from '../access/caller.js';
import { peopleInScope } from '../access/scope.js';
import type { Scope } from '../moduleRegistry/manifest.js';
import { User } from '../models/user.js';

/**
 * Whose API tokens and connected apps someone may see or revoke with apiToken.read or apiToken.delete: the people
 * their scope reaches. Super admins are left out unless the actor is one, because only a super admin can change a
 * super admin.
 */
export type OwnerReach = { onlyUserIds: string[] } | { allUserIdsExcept: string[] };

export async function findTokenOwnerReach(actor: Actor, scope: Scope): Promise<OwnerReach> {
  if (actor.user.superAdmin) return { allUserIdsExcept: [] };

  const superAdminIds: string[] = await User.find({ superAdmin: true }).distinct('_id');
  const reachedIds = await peopleInScope(actor.user._id, scope);
  if (reachedIds === null) return { allUserIdsExcept: superAdminIds };
  return { onlyUserIds: reachedIds.filter((id) => !superAdminIds.includes(id)) };
}

/** The same reach as a MongoDB condition on a userId field. */
export const ownerReachCondition = (reach: OwnerReach) =>
  'onlyUserIds' in reach ? { $in: reach.onlyUserIds } : { $nin: reach.allUserIdsExcept };

export const reachesOwner = (reach: OwnerReach, userId: string): boolean =>
  'onlyUserIds' in reach ? reach.onlyUserIds.includes(userId) : !reach.allUserIdsExcept.includes(userId);
