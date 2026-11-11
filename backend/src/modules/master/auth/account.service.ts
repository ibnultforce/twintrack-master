import { runInTransaction } from '../../../db.js';
import { ApiError } from '../../../lib/errors.js';
import { assertNotImpersonating, type Caller } from '../access/caller.js';
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
  /** The person's place in the organisation tree. */
  orgRoleId?: string;
  manager: { id: string; name: string } | null;
  employeeNumber?: number;
  photoUpdatedAt?: Date;
  /** The super admin seeing the app as this person, when that is what this session is. */
  impersonatedBy?: { id: string; name: string };
  /** Whether this session may start signing in as someone else, which only a super admin can, in development. */
  canImpersonate: boolean;
}

export async function getProfile(user: UserDoc, session: { impersonatorId?: string; isImpersonationEnabled?: boolean } = {}): Promise<Profile> {
  const { impersonatorId, isImpersonationEnabled = false } = session;
  const [manager, impersonator] = await Promise.all([
    user.managerId ? findUserById(user.managerId) : null,
    impersonatorId ? findUserById(impersonatorId) : null,
  ]);
  return {
    id: user._id,
    name: user.name,
    email: user.email,
    title: user.title,
    department: user.department,
    team: user.team,
    contract: user.contract,
    superAdmin: user.superAdmin,
    orgRoleId: user.orgRoleId,
    manager: manager ? { id: manager._id, name: manager.name } : null,
    employeeNumber: user.employeeNumber,
    photoUpdatedAt: user.photoUpdatedAt,
    ...(impersonator && { impersonatedBy: { id: impersonator._id, name: impersonator.name } }),
    canImpersonate: user.superAdmin && isImpersonationEnabled && !impersonatorId,
  };
}

/** People can change only their own name. HR owns job details such as title and department. */
export async function updateOwnName(caller: Caller, name: string, ipAddress: string | undefined): Promise<Profile> {
  assertNotImpersonating(caller);
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
/** Confirms the person at the keyboard before something sensitive. */
export async function assertOwnPassword(userId: string, password: string): Promise<void> {
  const userWithPassword = await findUserWithPasswordById(userId);
  // Not a 401, because frontends answer a 401 by refreshing the token and trying again.
  if (!(await isPasswordCorrect(password, userWithPassword?.passwordHash))) {
    throw new ApiError(403, 'wrong_current_password', 'Your current password is not correct.');
  }
}

export async function changeOwnPassword(
  caller: Caller,
  passwords: { currentPassword: string; newPassword: string },
  ipAddress: string | undefined,
): Promise<void> {
  assertNotImpersonating(caller);
  const { user, sessionId } = caller;
  await assertOwnPassword(user._id, passwords.currentPassword);

  const passwordHash = await hashPassword(passwords.newPassword);
  await runInTransaction(async (session) => {
    await updateUserPassword(user._id, passwordHash, session);
    await revokeOtherUserSessions(user._id, sessionId, session);
    await recordAudit({ action: 'auth.password_changed', actorId: user._id, actorName: user.name, ip: ipAddress }, session);
  });
}
