import type { ClientSession } from 'mongoose';
import { User } from '../models/user.js';
import type { UserRow } from './usersFile.js';

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
        update: { $set: row, $setOnInsert: { passwordHash, mustChangePassword: false } },
        upsert: true,
      },
    })),
    { session },
  );
  return { created: result.upsertedCount, updated: result.modifiedCount };
}
