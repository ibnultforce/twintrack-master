import { ApiError } from '../../../lib/errors.js';
import type { Actor } from '../access/caller.js';
import type { UserDoc } from '../models/user.js';

const REFUSALS = {
  super_admin_protected: 'Only a super admin can change a super admin.',
  own_account: 'Ask another admin to do this for your own account.',
} as const;

export type AccountRefusal = keyof typeof REFUSALS;

/** Without this, an Access Admin could reset a super admin's password and sign in as them. */
export function superAdminRefusal(actor: Actor, target: Pick<UserDoc, 'superAdmin'>): AccountRefusal | null {
  return target.superAdmin && !actor.user.superAdmin ? 'super_admin_protected' : null;
}

/** Nobody changes their own access or account standing, so one admin can't widen or rescue their own account. */
export function ownAccountRefusal(actor: Actor, target: Pick<UserDoc, '_id'>): AccountRefusal | null {
  return target._id === actor.user._id ? 'own_account' : null;
}

export function throwIfRefused(refusal: AccountRefusal | null): void {
  if (refusal) throw new ApiError(403, refusal, REFUSALS[refusal]);
}
