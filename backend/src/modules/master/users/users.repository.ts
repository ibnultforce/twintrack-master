import type { ClientSession } from 'mongoose';
import { User } from '../models/user.js';
import type { UserRow } from './usersFile.js';

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
