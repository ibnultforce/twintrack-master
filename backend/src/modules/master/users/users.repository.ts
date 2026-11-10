import type { ClientSession, QueryFilter } from 'mongoose';
import { escapeRegex, pageOffset, type PageRequest } from '../../../lib/query.js';
import { User, type UserDoc } from '../models/user.js';
import type { UserRow } from './usersFile.js';

const SEARCHED_FIELDS = ['name', 'email', 'title'] as const;

export type NewUserRecord = Pick<UserDoc, '_id' | 'name' | 'email' | 'contract' | 'passwordHash' | 'mustChangePassword' | 'orgRoleId'> &
  Partial<Pick<UserDoc, 'title' | 'department' | 'team' | 'managerId' | 'profileId'>>;

/** Fields an admin can edit. For the optional ones, null clears the value. */
export type UserDetailChanges = Partial<Pick<UserDoc, 'name' | 'email' | 'contract' | 'orgRoleId'>> &
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

export function setTemporaryPassword(userId: string, passwordHash: string, session: ClientSession) {
  return User.findByIdAndUpdate(
    userId,
    { $set: { passwordHash, mustChangePassword: true } },
    { returnDocument: 'after', session },
  ).lean();
}

/** The module key must already be validated, because it becomes part of a field path. */
export function updateUserPermissionSets(userId: string, moduleKey: string, setKeys: string[], session: ClientSession) {
  return User.findByIdAndUpdate(userId, setOrUnset({ [`permissionSets.${moduleKey}`]: setKeys.length > 0 ? setKeys : null }), {
    returnDocument: 'after',
    session,
  }).lean();
}

/** People with access in a module: a permission set there, or a profile that gives some. The module key must already be validated. */
const holdsAccessIn = (moduleKey: string, profileIdsWithAccess: string[]) => [
  { [`permissionSets.${moduleKey}`]: { $exists: true } },
  ...(profileIdsWithAccess.length > 0 ? [{ profileId: { $in: profileIdsWithAccess } }] : []),
];

/** The module key must already be validated, because it becomes part of a field path. */
export function findUsersWithAccessIn(moduleKey: string, profileIdsWithAccess: string[]) {
  return User.find({ $or: holdsAccessIn(moduleKey, profileIdsWithAccess) }).sort({ name: 1 }).lean();
}

/** Active people who could be given a permission set in a module. The module key must already be validated, as it becomes part of a field path. */
export function findUsersAddableTo(
  moduleKey: string,
  profileIdsWithAccess: string[],
  excludedUserId: string,
  { search, ...page }: PageRequest & { search?: string },
) {
  return findPageOfUsers({
    _id: { $ne: excludedUserId },
    status: 'active',
    superAdmin: { $ne: true },
    $nor: holdsAccessIn(moduleKey, profileIdsWithAccess),
    ...searchFilter(search),
  }, page);
}

export function countUsersWithPermissionSet(moduleKey: string, setKey: string, session: ClientSession) {
  return User.countDocuments({ [`permissionSets.${moduleKey}`]: setKey }).session(session);
}

export function countUsersWithPermissionSetsIn(moduleKey: string, session: ClientSession) {
  return User.countDocuments({ [`permissionSets.${moduleKey}`]: { $exists: true } }).session(session);
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

export function updateUserName(userId: string, name: string) {
  return User.findByIdAndUpdate(userId, { $set: { name } }, { returnDocument: 'after' }).lean();
}

/** Saves a new password, which also ends any requirement to change a temporary one. */
export async function updateUserPassword(userId: string, passwordHash: string, session?: ClientSession): Promise<void> {
  await User.updateOne({ _id: userId }, { $set: { passwordHash, mustChangePassword: false } }, { session });
}

/** People holding a set that isn't among these keys, such as after an import drops one. */
export function countUsersWithPermissionSetOutside(moduleKey: string, setKeys: string[], session?: ClientSession) {
  return User.countDocuments({
    [`permissionSets.${moduleKey}`]: { $elemMatch: { $nin: setKeys } },
  }).session(session ?? null);
}

/** Creates or updates users by id. Existing passwords are kept; passwordHash only applies to new users. */
export async function upsertUsers(rows: UserRow[], passwordHash: string, session?: ClientSession) {
  const result = await User.bulkWrite(
    rows.map(({ id, ...row }) => ({
      updateOne: {
        filter: { _id: id },
        // The file decides access, so a profile it no longer lists is taken away.
        update: {
          $set: row,
          $setOnInsert: { passwordHash, mustChangePassword: false },
          ...(row.profileId === undefined && { $unset: { profileId: 1 } }),
        },
        upsert: true,
      },
    })),
    { session },
  );
  return { created: result.upsertedCount, updated: result.modifiedCount };
}
