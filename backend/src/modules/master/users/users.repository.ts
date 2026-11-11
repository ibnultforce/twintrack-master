import type { ClientSession, QueryFilter } from 'mongoose';
import { escapeRegex, pageOffset, type PageRequest } from '../../../lib/query.js';
import { User, type UserDoc } from '../models/user.js';
import type { UserRow } from './usersFile.js';

const SEARCHED_FIELDS = ['name', 'email', 'title'] as const;

export type NewUserRecord = Pick<UserDoc, '_id' | 'name' | 'email' | 'contract' | 'passwordHash' | 'orgRoleId' | 'employeeNumber'> &
  Partial<Pick<UserDoc, 'title' | 'department' | 'team' | 'managerId' | 'profileId'>>;

/** Fields an admin can edit. For the optional ones, null clears the value. */
export type UserDetailChanges = Partial<Pick<UserDoc, 'name' | 'email' | 'contract' | 'orgRoleId' | 'employeeNumber'>> &
  Partial<Record<'title' | 'department' | 'team' | 'managerId' | 'profileId', string | null>>;

/** Turns a value of null into removing that field, because no field stores null. */
function setOrUnset(fields: Record<string, unknown>) {
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
  const toSet = entries.filter(([, value]) => value !== null);
  const toUnset = entries.filter(([, value]) => value === null);
  return {
    ...(toSet.length > 0 && { $set: Object.fromEntries(toSet) }),
    ...(toUnset.length > 0 && { $unset: Object.fromEntries(toUnset.map(([field]) => [field, 1])) }),
  };
}

function searchFilter(search: string | undefined) {
  if (!search) return {};
  const searchPattern = { $regex: escapeRegex(search), $options: 'i' };
  return { $or: SEARCHED_FIELDS.map((field) => ({ [field]: searchPattern })) };
}

async function findPageOfUsers(filter: QueryFilter<UserDoc>, page: PageRequest) {
  const [users, total] = await Promise.all([
    User.find(filter).sort({ name: 1, _id: 1 }).skip(pageOffset(page)).limit(page.pageSize).lean(),
    User.countDocuments(filter),
  ]);
  return { users, total };
}

export function findUsersPage({ search, status, ...page }: PageRequest & { search?: string; status?: UserDoc['status'] }) {
  return findPageOfUsers({ ...(status && { status }), ...searchFilter(search) }, page);
}

/** Active people anyone signed in may look up. Super admins are operators, not colleagues, so they're left out. */
export function findDirectoryPage({ search, ...page }: PageRequest & { search?: string }) {
  return findPageOfUsers({ status: 'active', superAdmin: { $ne: true }, ...searchFilter(search) }, page);
}

export async function insertUser(record: NewUserRecord, session: ClientSession): Promise<UserDoc> {
  const [created] = await User.create([record], { session });
  if (!created) throw new Error('Creating the user returned nothing.');
  return created.toObject();
}

export function updateUserDetails(userId: string, changes: UserDetailChanges, session: ClientSession) {
  return User.findByIdAndUpdate(userId, setOrUnset(changes), { returnDocument: 'after', session }).lean();
}

export function updateUserStatus(userId: string, status: UserDoc['status'], session: ClientSession) {
  return User.findByIdAndUpdate(userId, { $set: { status } }, { returnDocument: 'after', session }).lean();
}

/** Gives a person a profile, or takes it away with null. */
export function saveUserProfile(userId: string, profileId: string | null, session: ClientSession) {
  return User.findByIdAndUpdate(userId, setOrUnset({ profileId }), { returnDocument: 'after', session }).lean();
}

/** People whose profile gives them access to a module. */
export function findUsersWithAccessIn(profileIdsWithAccess: string[]) {
  return User.find({ profileId: { $in: profileIdsWithAccess } }).sort({ name: 1 }).lean();
}

/**
 * Active people without access to a module, among those the caller may reach (null for everyone), who could be given
 * a profile covering it. Leaves out super admins and the caller.
 */
export function findUsersAddableTo(
  profileIdsWithAccess: string[],
  excludedUserId: string,
  reachableIds: string[] | null,
  { search, ...page }: PageRequest & { search?: string },
) {
  return findPageOfUsers({
    _id: { $ne: excludedUserId, ...(reachableIds && { $in: reachableIds }) },
    status: 'active',
    superAdmin: { $ne: true },
    profileId: { $nin: profileIdsWithAccess },
    ...searchFilter(search),
  }, page);
}

export function countUsersWithProfiles(profileIds: string[], session: ClientSession) {
  return User.countDocuments({ profileId: { $in: profileIds } }).session(session);
}

/** Includes the password hash, which other queries leave out. Use it only to check a login. */
export function findUserWithPasswordByEmail(email: string) {
  return User.findOne({ email }).select('+passwordHash').lean();
}

/** Includes the password hash, which other queries leave out. Use it only to check a password. */
export function findUserWithPasswordById(userId: string) {
  return User.findById(userId).select('+passwordHash').lean();
}

export function findUserById(userId: string) {
  return User.findById(userId).lean();
}

export function findUsersByIds(userIds: string[]) {
  return User.find({ _id: { $in: userIds } }).lean();
}

/** Marks the person as seen now, unless that was already recorded after staleBefore. */
export async function recordUserSeen(userId: string, staleBefore: Date): Promise<void> {
  await User.updateOne(
    { _id: userId, $or: [{ lastSeenAt: { $exists: false } }, { lastSeenAt: { $lt: staleBefore } }] },
    { $set: { lastSeenAt: new Date() } },
  );
}

export async function recordUserSignedIn(userId: string): Promise<void> {
  const now = new Date();
  await User.updateOne({ _id: userId }, { $set: { lastSignedInAt: now, lastSeenAt: now } });
}

/** Records when the photo changed, or with null that there's no photo any more. */
export function savePhotoUpdatedAt(userId: string, photoUpdatedAt: Date | null, session: ClientSession) {
  return User.findByIdAndUpdate(userId, setOrUnset({ photoUpdatedAt }), { returnDocument: 'after', session }).lean();
}

export async function isManagerOfAnyone(userId: string): Promise<boolean> {
  return Boolean(await User.exists({ managerId: userId }));
}

export async function deleteUserRecord(userId: string, session: ClientSession): Promise<void> {
  await User.deleteOne({ _id: userId }, { session });
}

export function updateUserName(userId: string, name: string) {
  return User.findByIdAndUpdate(userId, { $set: { name } }, { returnDocument: 'after' }).lean();
}

export async function updateUserPassword(userId: string, passwordHash: string, session?: ClientSession): Promise<void> {
  await User.updateOne({ _id: userId }, { $set: { passwordHash } }, { session });
}

/** Creates or updates users by id. Existing passwords are kept; passwordHash only applies to new users. */
export async function upsertUsers(rows: UserRow[], passwordHash: string, session?: ClientSession) {
  const result = await User.bulkWrite(
    rows.map(({ id, ...row }) => ({
      updateOne: {
        filter: { _id: id },
        // The file decides access, so a profile it no longer lists is taken away, and so are permission sets from before
        // they were removed. strict: false lets that $unset reach a field no longer in the schema.
        update: {
          $set: row,
          $setOnInsert: { passwordHash },
          // mustChangePassword went with temporary passwords, which emailed links replaced.
          $unset: { permissionSets: 1, mustChangePassword: 1, ...(row.profileId === undefined && { profileId: 1 }) },
        },
        upsert: true,
      },
    })),
    { session, strict: false },
  );
  return { created: result.upsertedCount, updated: result.modifiedCount };
}
