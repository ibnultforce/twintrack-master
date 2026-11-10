import type { ClientSession } from 'mongoose';
import { AccessProfile, type AccessProfileDoc } from '../models/accessProfile.js';
import { User, type UserDoc } from '../models/user.js';

export type NewAccessProfileRecord = Pick<AccessProfileDoc, '_id' | 'name' | 'grants'> & Partial<Pick<AccessProfileDoc, 'description'>>;

/** The profile a person holds. A profile that has been removed counts as none. */
export function findProfileOf(user: Pick<UserDoc, 'profileId'>, session?: ClientSession) {
  return user.profileId ? AccessProfile.findById(user.profileId).session(session ?? null).lean() : Promise.resolve(null);
}

export function findAllProfiles(session?: ClientSession) {
  return AccessProfile.find().sort({ name: 1, _id: 1 }).session(session ?? null).lean();
}

export function findProfileById(profileId: string, session?: ClientSession) {
  return AccessProfile.findById(profileId).session(session ?? null).lean();
}

export async function countHoldersByProfile(): Promise<Map<string, number>> {
  const counts = await User.aggregate<{ _id: string; count: number }>([
    { $match: { profileId: { $exists: true } } },
    { $group: { _id: '$profileId', count: { $sum: 1 } } },
  ]);
  return new Map(counts.map(({ _id, count }) => [_id, count]));
}

export function countProfileHolders(profileId: string, session: ClientSession) {
  return User.countDocuments({ profileId }).session(session);
}

export async function insertProfile(record: NewAccessProfileRecord, session: ClientSession): Promise<AccessProfileDoc> {
  const [created] = await AccessProfile.create([record], { session });
  if (!created) throw new Error('Creating the profile returned nothing.');
  return created.toObject();
}

export function replaceProfileFields(
  profileId: string,
  fields: Pick<AccessProfileDoc, 'name' | 'grants'> & { description?: string },
  session: ClientSession,
) {
  const { description, ...required } = fields;
  const update = description === undefined
    ? { $set: required, $unset: { description: 1 } }
    : { $set: { ...required, description } };
  return AccessProfile.findByIdAndUpdate(profileId, update, { returnDocument: 'after', session }).lean();
}

/** Writes several profiles' grants at once, after a module's resources change. */
export async function saveProfileGrants(changes: { profileId: string; grants: AccessProfileDoc['grants'] }[], session: ClientSession): Promise<void> {
  if (changes.length === 0) return;
  await AccessProfile.bulkWrite(
    changes.map(({ profileId, grants }) => ({ updateOne: { filter: { _id: profileId }, update: { $set: { grants } } } })),
    { session },
  );
}

export async function deleteProfile(profileId: string, session: ClientSession): Promise<void> {
  await AccessProfile.deleteOne({ _id: profileId }, { session });
}

/** Creates or updates profiles by id, so the seed is safe to re-run. */
export async function upsertProfiles(rows: NewAccessProfileRecord[], session: ClientSession): Promise<void> {
  if (rows.length === 0) return;
  await AccessProfile.bulkWrite(
    rows.map(({ _id, description, ...row }) => ({
      updateOne: {
        filter: { _id },
        update: { $set: { ...row, ...(description !== undefined && { description }) }, ...(description === undefined && { $unset: { description: 1 } }) },
        upsert: true,
      },
    })),
    { session },
  );
}

/** The profiles that give something in a module. The module key must already be validated, as it becomes part of a field path. */
export async function findProfileIdsGranting(moduleKey: string): Promise<string[]> {
  return AccessProfile.find({ [`grants.${moduleKey}`]: { $exists: true } }).distinct('_id');
}
