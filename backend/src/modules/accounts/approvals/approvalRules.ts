import { ApiError } from '../../../lib/errors.js';
import type { Actor } from '../../master/access/caller.js';
import { findActiveStandInId } from '../settings/settings.service.js';

/*
 * Maker-checker for every Accounts record that needs approval (vouchers now; bills, payroll runs and update requests
 * later). Like the super admin rules, this is a safety rule kept in code: whoever made a record never decides on it,
 * super admins included. Everything else about who may approve comes from profiles.
 */

/** A record someone made, which someone else decides on. */
export interface DecidableRecord {
  createdBy?: string;
}

const ownRecord = () => new ApiError(403, 'own_record', 'You made this record, so someone else has to decide on it.');

const notAnApprover = () => new ApiError(403, 'forbidden', "Your profile doesn't let you approve this, and you aren't the stand-in approver today.");

/**
 * Lets the actor approve, return or reverse the record only if they didn't make it, and they hold the approve
 * permission or are the stand-in approver named in Settings for today.
 */
export async function assertMayDecide(actor: Actor, record: DecidableRecord, approvePermission: string): Promise<void> {
  if (record.createdBy === actor.user._id) throw ownRecord();
  if (actor.permissions[approvePermission]) return;
  if ((await findActiveStandInId()) === actor.user._id) return;
  throw notAnApprover();
}

/** Whether the actor could decide on the record, for showing or hiding buttons. Never use it in place of assertMayDecide. */
export async function mayDecide(actor: Actor, record: DecidableRecord, approvePermission: string): Promise<boolean> {
  try {
    await assertMayDecide(actor, record, approvePermission);
    return true;
  } catch (error) {
    if (error instanceof ApiError) return false;
    throw error;
  }
}
