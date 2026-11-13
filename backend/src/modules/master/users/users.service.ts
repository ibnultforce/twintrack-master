import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { isDuplicateKeyError, runInTransaction } from '../../../db.js';
import { ApiError } from '../../../lib/errors.js';
import type { PageRequest } from '../../../lib/query.js';
import { findUserReferences, type UserReferenceCheck } from '../../../lib/userReferences.js';
import { actorFields, type Actor } from '../access/caller.js';
import { recordAudit } from '../audit/audit.repository.js';
import { findProfileOf } from '../accessProfiles/accessProfiles.repository.js';
import { assertProfileWithinOwnAccess } from '../moduleRegistry/grantEditing.js';
import { assertOrgRoleExists } from '../orgRoles/orgRoles.service.js';
import { hashUnusablePassword } from '../auth/passwords.js';
import { sendPasswordLink, type PasswordLinkMailer } from '../auth/passwordLinks.service.js';
import { deletePasswordLinksOf } from '../auth/passwordLink.repository.js';
import { deleteSessionsOf, revokeAllUserSessions } from '../auth/session.repository.js';
import type { UserDoc } from '../models/user.js';
import { ownAccountRefusal, superAdminRefusal, throwIfRefused } from './accountRules.js';
import { takeNextEmployeeNumber } from './employeeNumbers.js';
import { deleteSharesGrantedTo } from '../records/recordAccess.service.js';
import { deletePhotoOf } from './photos.repository.js';
import { findOnlineStatus, type Viewer } from './presence.service.js';
import {
  deleteUserRecord,
  findUserById,
  findUsersPage,
  insertUser,
  isManagerOfAnyone,
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
  | 'profileId'
  | 'employeeNumber'
  | 'photoUpdatedAt'
  | 'lastSignedInAt'
> & {
  id: string;
  /** Left out when the viewer may not see this person's online status. */
  online?: boolean;
};

export interface CreatedUserResult {
  user: UserView;
  /** False when the invitation email couldn't be sent. An admin can send a new link from the person's page. */
  invitationSent: boolean;
}

export type NewUserDetails = Pick<UserDoc, 'name' | 'email' | 'contract'> & { orgRoleId: string } &
  Partial<Pick<UserDoc, 'title' | 'department' | 'team' | 'managerId'>>;

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
    profileId: user.profileId,
    employeeNumber: user.employeeNumber,
    photoUpdatedAt: user.photoUpdatedAt,
    lastSignedInAt: user.lastSignedInAt,
  };
}

/** The people as this viewer sees them, with online status where the viewer may see it. */
async function toUserViewsFor(viewer: Viewer, users: UserDoc[]): Promise<UserView[]> {
  const online = await findOnlineStatus(viewer, users);
  return users.map((user) => {
    const isOnline = online.get(user._id);
    return { ...toUserView(user), ...(isOnline !== undefined && { online: isOnline }) };
  });
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

const assertMayManageAccount = (actor: Actor, target: UserDoc) => throwIfRefused(superAdminRefusal(actor, target));
const assertNotOwnAccount = (actor: Actor, target: UserDoc) => throwIfRefused(ownAccountRefusal(actor, target));

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

const duplicatedField = (error: unknown) =>
  error instanceof mongoose.mongo.MongoServerError ? Object.keys((error.keyPattern ?? {}) as object)[0] : undefined;

/** Turns a clash on a unique field into an answer naming the field. */
async function withUniqueFields<Result>(write: () => Promise<Result>): Promise<Result> {
  try {
    return await write();
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    if (duplicatedField(error) === 'employeeNumber') {
      throw new ApiError(409, 'employee_number_taken', 'Someone already has that employee number.');
    }
    throw new ApiError(409, 'email_taken', 'Someone already uses that email address.');
  }
}

export async function listUsers(viewer: Viewer, query: PageRequest & { search?: string; status?: UserDoc['status'] }) {
  const { users, total } = await findUsersPage(query);
  return { users: await toUserViewsFor(viewer, users), total };
}

export async function getUser(viewer: Viewer, userId: string): Promise<UserView> {
  const [view] = await toUserViewsFor(viewer, [await requireUser(userId)]);
  if (!view) throw new Error('Viewing one person returned nothing.');
  return view;
}

/** Adds a person and emails them a link to set their password. Nobody can sign in as them until they do. */
export async function createUser(mailer: PasswordLinkMailer, actor: Actor, details: NewUserDetails): Promise<CreatedUserResult> {
  if (details.managerId) await assertValidManager(details.managerId);
  await assertOrgRoleExists(details.orgRoleId);

  const passwordHash = await hashUnusablePassword();
  const employeeNumber = await takeNextEmployeeNumber();
  const user = await withUniqueFields(() =>
    runInTransaction(async (session) => {
      const created = await insertUser({ _id: `u_${randomUUID()}`, ...details, employeeNumber, passwordHash }, session);
      await recordAudit({ action: 'user.created', ...actorFields(actor), ...userTargetFields(created), after: details }, session);
      return created;
    }),
  );
  const invitationSent = await sendPasswordLink(mailer, user, 'invite', actor);
  return { user: toUserView(user), invitationSent };
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
  // Password links go to the email, so whoever sets it can take the account over. Nobody may take over more than their own access.
  const targetProfile = changes.email ? await findProfileOf(target) : null;
  if (targetProfile) await assertProfileWithinOwnAccess(actor, targetProfile);
  if (changes.managerId) await assertValidManager(changes.managerId, target._id);
  // A place in the tree widens or narrows what someone's scope reaches, so only a super admin may change their own.
  if (changes.orgRoleId && !actor.user.superAdmin) assertNotOwnAccount(actor, target);
  if (changes.orgRoleId) await assertOrgRoleExists(changes.orgRoleId);

  const before = Object.fromEntries(changedFields.map((field) => [field, target[field] ?? null]));
  const updated = await withUniqueFields(() =>
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

/**
 * Removes someone added by mistake. Only an account nobody has ever signed in to can go, and only while no record in
 * any module points at them. Everyone else is deactivated instead, so their history stays whole.
 */
export async function deleteNeverSignedInUser(actor: Actor, userId: string, referenceChecks: UserReferenceCheck[]): Promise<void> {
  const target = await requireUser(userId);
  assertNotOwnAccount(actor, target);
  assertMayManageAccount(actor, target);
  if (target.lastSignedInAt) {
    throw new ApiError(409, 'has_signed_in', 'This person has signed in, so they can only be deactivated.');
  }

  const references = await findUserReferences(referenceChecks, target._id);
  if (await isManagerOfAnyone(target._id)) references.unshift('people who report to them');
  if (references.length > 0) {
    throw new ApiError(409, 'user_in_use', `This person is still named in ${references.join(', ')}, so they can only be deactivated.`);
  }

  await runInTransaction(async (session) => {
    await deleteUserRecord(target._id, session);
    await deletePasswordLinksOf(target._id, session);
    await deleteSessionsOf(target._id, session);
    await deletePhotoOf(target._id, session);
    await deleteSharesGrantedTo(target._id, session);
    await recordAudit(
      { action: 'user.deleted', ...actorFields(actor), ...userTargetFields(target), before: { name: target.name, email: target.email } },
      session,
    );
  });
}
