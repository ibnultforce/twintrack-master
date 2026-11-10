import { randomUUID } from 'node:crypto';
import { isDuplicateKeyError, runInTransaction } from '../../../db.js';
import { ApiError } from '../../../lib/errors.js';
import type { PageRequest } from '../../../lib/query.js';
import { actorFields, type Actor } from '../access/caller.js';
import { recordAudit } from '../audit/audit.repository.js';
import { assertProfileExists } from '../accessProfiles/accessProfiles.service.js';
import { assertOrgRoleExists } from '../orgRoles/orgRoles.service.js';
import { generateTemporaryPassword, hashPassword } from '../auth/passwords.js';
import { revokeAllUserSessions } from '../auth/session.repository.js';
import type { UserDoc } from '../models/user.js';
import {
  findUserById,
  findUsersPage,
  insertUser,
  setTemporaryPassword,
  updateUserDetails as saveUserDetails,
  updateUserStatus,
  type UserDetailChanges,
} from './users.repository.js';

export type UserView = Pick<
  UserDoc,
  | 'name'
  | 'email'
  | 'title'
  | 'department'
  | 'team'
  | 'contract'
  | 'status'
  | 'managerId'
  | 'orgRoleId'
  | 'superAdmin'
  | 'mustChangePassword'
  | 'profileId'
  | 'permissionSets'
> & { id: string };

/** The only time a temporary password is available. Only its hash is stored. */
export interface TemporaryPasswordResult {
  user: UserView;
  temporaryPassword: string;
}

export type NewUserDetails = Pick<UserDoc, 'name' | 'email' | 'contract'> & { orgRoleId: string } &
  Partial<Pick<UserDoc, 'title' | 'department' | 'team' | 'managerId' | 'profileId'>>;

/** Lists each field explicitly, so the password hash can never reach a response. */
export function toUserView(user: UserDoc): UserView {
  return {
    id: user._id,
    name: user.name,
    email: user.email,
    title: user.title,
    department: user.department,
    team: user.team,
    contract: user.contract,
    status: user.status,
    managerId: user.managerId,
    orgRoleId: user.orgRoleId,
    superAdmin: user.superAdmin,
    mustChangePassword: user.mustChangePassword,
    profileId: user.profileId,
    permissionSets: user.permissionSets ?? {},
  };
}

export const userTargetFields = (user: Pick<UserDoc, '_id' | 'name'>) => ({
  targetType: 'user',
  targetId: user._id,
  targetName: user.name,
});

export async function requireUser(userId: string): Promise<UserDoc> {
  const user = await findUserById(userId);
  if (!user) throw new ApiError(404, 'unknown_user', 'No such user.');
  return user;
}

/** Without this, an Access Admin could reset a super admin's password and sign in as them. */
function assertMayManageAccount(actor: Actor, target: UserDoc): void {
  if (target.superAdmin && !actor.user.superAdmin) {
    throw new ApiError(403, 'super_admin_protected', 'Only a super admin can change a super admin.');
  }
}

function assertNotOwnAccount(actor: Actor, target: UserDoc): void {
  if (target._id === actor.user._id) {
    throw new ApiError(403, 'own_account', 'Ask another admin to do this for your own account.');
  }
}

const invalidManager = (message: string) =>
  new ApiError(422, 'validation_failed', 'Some fields are invalid.', [{ path: 'managerId', message }]);

/** Follows the new reporting line upwards, so a change can't turn it into a circle. */
async function assertValidManager(managerId: string, employeeId?: string): Promise<void> {
  if (managerId === employeeId) throw invalidManager('a person cannot be their own manager');

  const manager = await findUserById(managerId);
  if (!manager) throw invalidManager(`manager "${managerId}" does not exist`);

  const visitedIds = new Set([managerId]);
  let nextId = manager.managerId;
  while (nextId) {
    if (nextId === employeeId || visitedIds.has(nextId)) throw invalidManager('this reporting line goes round in a circle');
    visitedIds.add(nextId);
    nextId = (await findUserById(nextId))?.managerId;
  }
}

async function withUniqueEmail<Result>(write: () => Promise<Result>): Promise<Result> {
  try {
    return await write();
  } catch (error) {
    if (isDuplicateKeyError(error)) throw new ApiError(409, 'email_taken', 'Someone already uses that email address.');
    throw error;
  }
}

export async function listUsers(query: PageRequest & { search?: string; status?: UserDoc['status'] }) {
  const { users, total } = await findUsersPage(query);
  return { users: users.map(toUserView), total };
}

export async function getUser(userId: string): Promise<UserView> {
  return toUserView(await requireUser(userId));
}

/** Adds a person with a one-time temporary password, which they must replace at first login. */
export async function createUser(actor: Actor, details: NewUserDetails): Promise<TemporaryPasswordResult> {
  if (details.managerId) await assertValidManager(details.managerId);
  await assertOrgRoleExists(details.orgRoleId);
  if (details.profileId) await assertProfileExists(details.profileId);

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  const user = await withUniqueEmail(() =>
    runInTransaction(async (session) => {
      const created = await insertUser({ _id: `u_${randomUUID()}`, ...details, passwordHash, mustChangePassword: true }, session);
      await recordAudit({ action: 'user.created', ...actorFields(actor), ...userTargetFields(created), after: details }, session);
      return created;
    }),
  );
  return { user: toUserView(user), temporaryPassword };
}

function findChangedDetails(target: UserDoc, requested: UserDetailChanges): UserDetailChanges {
  return Object.fromEntries(
    Object.entries(requested).filter(([field, value]) => (value ?? undefined) !== target[field as keyof UserDetailChanges]),
  );
}

export async function updateUserDetails(actor: Actor, userId: string, requested: UserDetailChanges): Promise<UserView> {
  const target = await requireUser(userId);
  assertMayManageAccount(actor, target);

  const changes = findChangedDetails(target, requested);
  const changedFields = Object.keys(changes) as (keyof UserDetailChanges)[];
  if (changedFields.length === 0) return toUserView(target);
  if (changes.managerId) await assertValidManager(changes.managerId, target._id);
  // A place in the tree and a profile both widen or narrow someone's access, so only a super admin may change their own.
  if ((changes.orgRoleId || changes.profileId !== undefined) && !actor.user.superAdmin) assertNotOwnAccount(actor, target);
  if (changes.orgRoleId) await assertOrgRoleExists(changes.orgRoleId);
  if (changes.profileId) await assertProfileExists(changes.profileId);

  const before = Object.fromEntries(changedFields.map((field) => [field, target[field] ?? null]));
  const updated = await withUniqueEmail(() =>
    runInTransaction(async (session) => {
      const saved = await saveUserDetails(target._id, changes, session);
      await recordAudit({ action: 'user.updated', ...actorFields(actor), ...userTargetFields(target), before, after: changes }, session);
      return saved;
    }),
  );
  if (!updated) throw new ApiError(404, 'unknown_user', 'No such user.');
  return toUserView(updated);
}

/** Deactivating ends every session too, so reactivating someone later can't bring an old session back. */
export async function setUserStatus(actor: Actor, userId: string, status: UserDoc['status']): Promise<UserView> {
  const target = await requireUser(userId);
  assertNotOwnAccount(actor, target);
  assertMayManageAccount(actor, target);
  if (target.status === status) return toUserView(target);

  const updated = await runInTransaction(async (session) => {
    const saved = await updateUserStatus(target._id, status, session);
    if (status === 'inactive') await revokeAllUserSessions(target._id, session);
    await recordAudit(
      {
        action: status === 'inactive' ? 'user.deactivated' : 'user.reactivated',
        ...actorFields(actor),
        ...userTargetFields(target),
        before: { status: target.status },
        after: { status },
      },
      session,
    );
    return saved;
  });
  if (!updated) throw new ApiError(404, 'unknown_user', 'No such user.');
  return toUserView(updated);
}

/** Replaces the password with a one-time temporary one and signs the person out everywhere. */
export async function resetUserPassword(actor: Actor, userId: string): Promise<TemporaryPasswordResult> {
  const target = await requireUser(userId);
  assertNotOwnAccount(actor, target);
  assertMayManageAccount(actor, target);

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  const updated = await runInTransaction(async (session) => {
    const saved = await setTemporaryPassword(target._id, passwordHash, session);
    await revokeAllUserSessions(target._id, session);
    await recordAudit({ action: 'user.password_reset', ...actorFields(actor), ...userTargetFields(target) }, session);
    return saved;
  });
  if (!updated) throw new ApiError(404, 'unknown_user', 'No such user.');
  return { user: toUserView(updated), temporaryPassword };
}
