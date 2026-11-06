import { runInTransaction } from '../../../db.js';
import { ApiError } from '../../../lib/errors.js';
import type { Caller } from '../access/caller.js';
import { recordAudit } from '../audit/audit.repository.js';
import type { UserDoc } from '../models/user.js';
import { findUserById, findUserWithPasswordById, updateUserName, updateUserPassword } from '../users/users.repository.js';
import { hashPassword, isPasswordCorrect } from './passwords.js';
import { revokeOtherUserSessions } from './session.repository.js';

export interface Profile {
  id: string;
  name: string;
  email: string;
  title?: string;
  department?: string;
  team?: string;
  contract: UserDoc['contract'];
  superAdmin: boolean;
  mustChangePassword: boolean;
  manager: { id: string; name: string } | null;
}

export async function getProfile(user: UserDoc): Promise<Profile> {
  const manager = user.managerId ? await findUserById(user.managerId) : null;
  return {
    id: user._id,
    name: user.name,
    email: user.email,
    title: user.title,
    department: user.department,
    team: user.team,
    contract: user.contract,
    superAdmin: user.superAdmin,
    mustChangePassword: user.mustChangePassword,
    manager: manager ? { id: manager._id, name: manager.name } : null,
  };
}

/** People can change only their own name. HR owns job details such as title and department. */
export async function updateOwnName(caller: Caller, name: string, ipAddress: string | undefined): Promise<Profile> {
  const { user } = caller;
  const updatedUser = await updateUserName(user._id, name);
  if (!updatedUser) throw new ApiError(404, 'unknown_user', 'No such user.');

  if (user.name !== name) {
    await recordAudit({
      action: 'user.name_changed',
      actorId: user._id,
      actorName: name,
      targetType: 'user',
      targetId: user._id,
      targetName: name,
      before: { name: user.name },
      after: { name },
      ip: ipAddress,
    });
  }
  return getProfile(updatedUser);
}

/** Replaces the password and ends every other session, in case someone else was signed in. This one stays open. */
export async function changeOwnPassword(
  caller: Caller,
  passwords: { currentPassword: string; newPassword: string },
  ipAddress: string | undefined,
): Promise<void> {
  const { user, sessionId } = caller;
  const userWithPassword = await findUserWithPasswordById(user._id);

  // Not a 401, because frontends answer a 401 by refreshing the token and trying again.
  if (!(await isPasswordCorrect(passwords.currentPassword, userWithPassword?.passwordHash))) {
    throw new ApiError(403, 'wrong_current_password', 'Your current password is not correct.');
  }

  const passwordHash = await hashPassword(passwords.newPassword);
  await runInTransaction(async (session) => {
    await updateUserPassword(user._id, passwordHash, session);
    await revokeOtherUserSessions(user._id, sessionId, session);
    await recordAudit({ action: 'auth.password_changed', actorId: user._id, actorName: user.name, ip: ipAddress }, session);
  });
}
