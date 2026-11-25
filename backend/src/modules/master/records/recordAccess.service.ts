import { randomUUID } from 'node:crypto';
import type { ClientSession, QueryFilter } from 'mongoose';
import { isDuplicateKeyError, runInTransaction } from '../../../db.js';
import { ApiError } from '../../../lib/errors.js';
import { actorFields, type Actor } from '../access/caller.js';
import { peopleInScope } from '../access/scope.js';
import { recordAudit } from '../audit/audit.repository.js';
import { OrgRole } from '../models/orgRole.js';
import { RecordShare, type GranteeType, type RecordShareDoc, type ShareAccess } from '../models/recordShare.js';
import { User, type UserDoc } from '../models/user.js';
import type { Scope, SharingModel } from '../moduleRegistry/manifest.js';
import { findModuleByKey } from '../moduleRegistry/moduleRegistry.repository.js';
import type { RecordRef } from './recordHistory.service.js';

/** What someone wants to do with a record. Reading and editing can come from a share. Nothing else can. */
export type RecordNeed = 'read' | 'edit';

/** A record and the people it belongs to, whose place decides whose scope reaches it. */
export interface ScopedRecord extends RecordRef {
  /** For a salary, the employee. The first one is the owner. */
  peopleIds: string[];
}

export async function findSharingModel(moduleKey: string, resourceKey: string, session?: ClientSession): Promise<SharingModel> {
  const module = await findModuleByKey(moduleKey, session);
  return module?.resources.find((resource) => resource.key === resourceKey)?.sharingModel ?? 'private';
}

const sharingModelOpens = (model: SharingModel, need: RecordNeed) => model === 'publicReadWrite' || (model === 'publicRead' && need === 'read');

/** Every way a share can name this person: themselves, their org role, or that role or any role above it with everything below. */
function granteeMatchesFor(user: Pick<UserDoc, '_id' | 'orgRoleId'>, ancestorIds: string[]) {
  const matches: { granteeType: GranteeType; granteeId: string | { $in: string[] } }[] = [{ granteeType: 'user', granteeId: user._id }];
  if (user.orgRoleId) {
    matches.push({ granteeType: 'orgRole', granteeId: user.orgRoleId });
    matches.push({ granteeType: 'orgRoleAndBelow', granteeId: { $in: [user.orgRoleId, ...ancestorIds] } });
  }
  return matches;
}

async function activeSharesFilter(user: Pick<UserDoc, '_id' | 'orgRoleId'>, moduleKey: string, objectKey: string, need: RecordNeed): Promise<QueryFilter<RecordShareDoc>> {
  const orgRole = user.orgRoleId ? await OrgRole.findById(user.orgRoleId).select('ancestorIds').lean() : null;
  return <QueryFilter<RecordShareDoc>>{
    module: moduleKey,
    object: objectKey,
    ...(need === 'edit' && { access: 'edit' }),
    $and: [
      { $or: granteeMatchesFor(user, orgRole?.ancestorIds ?? []) },
      { $or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gt: new Date() } }] },
    ],
  };
}

/** The ids of records of one kind shared with this person, at least at the access needed. */
export async function findSharedRecordIds(user: Pick<UserDoc, '_id' | 'orgRoleId'>, moduleKey: string, objectKey: string, need: RecordNeed): Promise<string[]> {
  return RecordShare.find(await activeSharesFilter(user, moduleKey, objectKey, need)).distinct('recordId');
}

async function isSharedWith(user: Pick<UserDoc, '_id' | 'orgRoleId'>, ref: RecordRef, need: RecordNeed): Promise<boolean> {
  return Boolean(await RecordShare.exists({ ...(await activeSharesFilter(user, ref.module, ref.object, need)), recordId: ref.recordId }));
}

const reachesAnyOf = (reached: string[] | null, peopleIds: string[]) => reached === null || peopleIds.some((personId) => reached.includes(personId));

/**
 * Whether someone, already holding the permission for what they want to do, reaches this record. Their scope reaches it,
 * the object's sharing model opens it, or it's shared with them at that access.
 */
export async function canReachRecord(actor: Actor, scope: Scope, record: ScopedRecord, need: RecordNeed): Promise<boolean> {
  if (reachesAnyOf(await peopleInScope(actor.user._id, scope), record.peopleIds)) return true;
  if (sharingModelOpens(await findSharingModel(record.module, record.object), need)) return true;
  return isSharedWith(actor.user, record, need);
}

export async function assertCanReachRecord(actor: Actor, scope: Scope, record: ScopedRecord, need: RecordNeed): Promise<void> {
  if (!(await canReachRecord(actor, scope, record, need))) {
    throw new ApiError(403, 'out_of_scope', 'This record is outside what your access reaches.');
  }
}

/**
 * Who may share records of one object: a super admin, the people a record belongs to, anyone above them (whom a team
 * scope reaches), or someone holding the object's share permission with a scope that reaches them. Worked out once, so
 * a page of records can each say whether the person may share it, the same way the share routes decide.
 */
export async function shareAllowance(actor: Actor, objectKey: string): Promise<(peopleIds: string[]) => boolean> {
  if (actor.user.superAdmin) return () => true;
  const shareScope = actor.permissions[`${objectKey}.share`];
  const [teamReach, shareReach] = await Promise.all([
    peopleInScope(actor.user._id, 'team'),
    shareScope ? peopleInScope(actor.user._id, shareScope) : Promise.resolve(undefined),
  ]);
  return (peopleIds) => {
    const owner = peopleIds[0];
    if (owner && reachesAnyOf(teamReach, [owner])) return true;
    return shareReach !== undefined && reachesAnyOf(shareReach, peopleIds);
  };
}

async function assertMayShare(actor: Actor, record: ScopedRecord): Promise<void> {
  if ((await shareAllowance(actor, record.object))(record.peopleIds)) return;
  throw new ApiError(403, 'may_not_share', `Only the owner, someone above them, or someone with ${record.object}.share can share this.`);
}

const toShareView = (share: RecordShareDoc, names: Map<string, string>) => ({
  id: share._id,
  granteeType: share.granteeType,
  granteeId: share.granteeId,
  /** The person's or org role's name, for showing; missing if it has since been removed. */
  granteeName: names.get(`${share.granteeType === 'user' ? 'user' : 'orgRole'}:${share.granteeId}`),
  access: share.access,
  expiresAt: share.expiresAt,
  sharedBy: share.sharedBy,
  sharedByName: names.get(`user:${share.sharedBy}`),
  createdAt: share.createdAt,
});

/** The names of the people and org roles a set of shares names, keyed "user:<id>" or "orgRole:<id>". */
async function namesForShares(shares: RecordShareDoc[]): Promise<Map<string, string>> {
  const userIds = [...new Set(shares.flatMap((share) => [share.sharedBy, ...(share.granteeType === 'user' ? [share.granteeId] : [])]))];
  const roleIds = [...new Set(shares.filter((share) => share.granteeType !== 'user').map((share) => share.granteeId))];
  const [users, roles] = await Promise.all([
    userIds.length ? User.find({ _id: { $in: userIds } }).select('name').lean() : [],
    roleIds.length ? OrgRole.find({ _id: { $in: roleIds } }).select('name').lean() : [],
  ]);
  return new Map([...users.map((user) => [`user:${user._id}`, user.name] as const), ...roles.map((role) => [`orgRole:${role._id}`, role.name] as const)]);
}

export async function listRecordShares(ref: RecordRef) {
  const shares = await RecordShare.find({ module: ref.module, object: ref.object, recordId: ref.recordId }).sort({ createdAt: 1, _id: 1 }).lean();
  const names = await namesForShares(shares);
  return { shares: shares.map((share) => toShareView(share, names)) };
}

const invalidGrantee = (message: string) => new ApiError(422, 'validation_failed', 'Some fields are invalid.', [{ path: 'granteeId', message }]);

async function assertGranteeExists(granteeType: GranteeType, granteeId: string): Promise<void> {
  const exists = granteeType === 'user' ? await User.exists({ _id: granteeId }) : await OrgRole.exists({ _id: granteeId });
  if (!exists) throw invalidGrantee(granteeType === 'user' ? `no such person "${granteeId}"` : `no such org role "${granteeId}"`);
}

export interface ShareInput {
  granteeType: GranteeType;
  granteeId: string;
  access: ShareAccess;
  expiresAt?: Date;
}

const auditFields = (actor: Actor, record: RecordRef, share: Pick<RecordShareDoc, 'granteeType' | 'granteeId' | 'access'>) => ({
  ...actorFields(actor),
  targetType: record.object,
  targetId: record.recordId,
  module: record.module,
  after: { granteeType: share.granteeType, granteeId: share.granteeId, access: share.access },
});

/** Shares a record, or changes the access of an existing share with the same grantee. */
export async function shareRecord(actor: Actor, record: ScopedRecord, input: ShareInput) {
  await assertMayShare(actor, record);
  await assertGranteeExists(input.granteeType, input.granteeId);
  if (input.expiresAt && input.expiresAt <= new Date()) {
    throw new ApiError(422, 'validation_failed', 'Some fields are invalid.', [{ path: 'expiresAt', message: 'must be in the future' }]);
  }

  const key = { module: record.module, object: record.object, recordId: record.recordId, granteeType: input.granteeType, granteeId: input.granteeId };
  try {
    const saved = await runInTransaction(async (session) => {
      const share = await RecordShare.findOneAndUpdate(
        key,
        {
          $set: { access: input.access, sharedBy: actor.user._id, ...(input.expiresAt && { expiresAt: input.expiresAt }) },
          ...(!input.expiresAt && { $unset: { expiresAt: 1 } }),
          $setOnInsert: { _id: `sh_${randomUUID()}` },
        },
        { upsert: true, returnDocument: 'after', session },
      ).lean();
      await recordAudit({ action: 'record.shared', ...auditFields(actor, record, input) }, session);
      return share!;
    });
    return toShareView(saved, await namesForShares([saved]));
  } catch (error) {
    // Two requests sharing with the same person at once: the unique index lets one in, and the other can simply retry.
    if (isDuplicateKeyError(error)) throw new ApiError(409, 'share_conflict', 'That share was just changed. Try again.');
    throw error;
  }
}

export async function unshareRecord(actor: Actor, record: ScopedRecord, shareId: string) {
  await assertMayShare(actor, record);
  await runInTransaction(async (session) => {
    const share = await RecordShare.findOneAndDelete({ _id: shareId, module: record.module, object: record.object, recordId: record.recordId }, { session }).lean();
    if (!share) throw new ApiError(404, 'unknown_share', 'No such share on this record.');
    await recordAudit({ action: 'record.unshared', ...auditFields(actor, record, share) }, session);
  });
  return { removed: true, id: shareId };
}

/** Removes shares made to one person by name, when that person is deleted. */
export async function deleteSharesGrantedTo(userId: string, session: ClientSession): Promise<void> {
  await RecordShare.deleteMany({ granteeType: 'user', granteeId: userId }, { session });
}
