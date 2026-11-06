import type { ClientSession } from 'mongoose';
import { escapeRegex, pageOffset, type PageRequest } from '../../../lib/query.js';
import { User, type UserDoc } from '../models/user.js';
import type { UserRow } from './usersFile.js';

const SEARCHED_FIELDS = ['name', 'email', 'title'] as const;

export type NewUserRecord = Pick<UserDoc, '_id' | 'name' | 'email' | 'contract' | 'passwordHash' | 'mustChangePassword'> &
  Partial<Pick<UserDoc, 'title' | 'department' | 'team' | 'managerId'>>;

/** Fields an admin can edit. For the optional ones, null clears the value. */
export type UserDetailChanges = Partial<Pick<UserDoc, 'name' | 'email' | 'contract'>> &
  Partial<Record<'title' | 'department' | 'team' | 'managerId', string | null>>;

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

export async function findUsersPage({ search, status, ...page }: PageRequest & { search?: string; status?: UserDoc['status'] }) {
  const searchPattern = search ? { $regex: escapeRegex(search), $options: 'i' } : undefined;
  const filter = {
    ...(status && { status }),
    ...(searchPattern && { $or: SEARCHED_FIELDS.map((field) => ({ [field]: searchPattern })) }),
  };
  const [users, total] = await Promise.all([
    User.find(filter).sort({ name: 1, _id: 1 }).skip(pageOffset(page)).limit(page.pageSize).lean(),
    User.countDocuments(filter),
  ]);
  return { users, total };
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
export function updateUserRole(userId: string, moduleKey: string, roleKey: string | null, session: ClientSession) {
  return User.findByIdAndUpdate(userId, setOrUnset({ [`assignments.${moduleKey}`]: roleKey }), {
    returnDocument: 'after',
    session,
  }).lean();
}

/** The module key must already be validated, because it becomes part of a field path. */
export function updateUserPrivileges(
  userId: string,
  moduleKey: string,
  change: { privileges: string[]; superAdminGrants?: string[] },
  session: ClientSession,
) {
  const valueFor = (permissions: string[] | undefined) => (permissions && permissions.length === 0 ? null : permissions);
  return User.findByIdAndUpdate(
    userId,
    setOrUnset({
      [`privileges.${moduleKey}`]: valueFor(change.privileges),
      [`superAdminGrants.${moduleKey}`]: valueFor(change.superAdminGrants),
    }),
    { returnDocument: 'after', session },
  ).lean();
}

/** The module key must already be validated, because it becomes part of a field path. */
export function findUsersWithAccessIn(moduleKey: string) {
  return User.find({
    $or: [
      { [`assignments.${moduleKey}`]: { $exists: true } },
      { [`privileges.${moduleKey}`]: { $exists: true } },
      { [`superAdminGrants.${moduleKey}`]: { $exists: true } },
    ],
  })
    .sort({ name: 1 })
    .lean();
}

export function countUsersWithRole(moduleKey: string, roleKey: string) {
  return User.countDocuments({ [`assignments.${moduleKey}`]: roleKey });
}

export function countUsersWithAccessIn(moduleKey: string, session: ClientSession) {
  return User.countDocuments({
    $or: [{ [`assignments.${moduleKey}`]: { $exists: true } }, { [`privileges.${moduleKey}`]: { $exists: true } }],
  }).session(session);
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

export function countUsersWithRoleOutside(moduleKey: string, roleKeys: string[], session?: ClientSession) {
  return User.countDocuments({
    [`assignments.${moduleKey}`]: { $exists: true, $nin: roleKeys },
  }).session(session ?? null);
}

/** Creates or updates users by id. Existing passwords are kept; passwordHash only applies to new users. */
export async function upsertUsers(rows: UserRow[], passwordHash: string, session?: ClientSession) {
  const result = await User.bulkWrite(
    rows.map(({ id, ...row }) => ({
      updateOne: {
        filter: { _id: id },
        update: { $set: { ...row, superAdminGrants: {} }, $setOnInsert: { passwordHash, mustChangePassword: false } },
        upsert: true,
      },
    })),
    { session },
  );
  return { created: result.upsertedCount, updated: result.modifiedCount };
}
