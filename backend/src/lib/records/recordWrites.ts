import type { ClientSession, Model, UpdateQuery } from 'mongoose';
import { ApiError } from '../errors.js';
import { ONLY_DELETED, WITH_DELETED, type RecordFields } from './recordFields.js';

interface ChangeOptions {
  actorId: string;
  /** The version the caller last read. When given, a record changed since then is refused instead of overwritten. */
  expectedVersion?: number;
  session: ClientSession;
}

const versionConflict = () =>
  new ApiError(409, 'version_conflict', 'Someone changed this record after you read it. Reload it and try again.');

/**
 * Applies one change to a record: records who made it, moves the version on, and refuses a stale edit.
 * Returns the record as saved, or throws `notFound` when there is no such record.
 */
async function applyChange<Doc extends RecordFields>(
  model: Model<Doc>,
  filter: Record<string, unknown>,
  update: UpdateQuery<Doc>,
  { actorId, expectedVersion, session }: ChangeOptions,
  notFound: () => ApiError,
): Promise<Doc> {
  const guardedFilter = { ...filter, ...(expectedVersion !== undefined && { version: expectedVersion }) };
  const fullUpdate = { ...update, $set: { ...(update.$set ?? {}), updatedBy: actorId }, $inc: { ...(update.$inc ?? {}), version: 1 } } as UpdateQuery<Doc>;
  const saved = await model.findOneAndUpdate(guardedFilter, fullUpdate, { returnDocument: 'after', session, ...WITH_DELETED }).lean<Doc>();
  if (saved) return saved;

  const exists = expectedVersion !== undefined && (await model.exists(filter).setOptions(WITH_DELETED).session(session));
  throw exists ? versionConflict() : notFound();
}

/** Changes a record that isn't in the recycle bin. */
export function changeRecord<Doc extends RecordFields>(model: Model<Doc>, recordId: string, update: UpdateQuery<Doc>, options: ChangeOptions, notFound: () => ApiError) {
  return applyChange(model, { _id: recordId, deletedAt: { $exists: false } }, update, options, notFound);
}

/** Moves a record to the recycle bin. It stays in the database, so it can be restored with its history. */
export function moveToRecycleBin<Doc extends RecordFields>(model: Model<Doc>, recordId: string, options: ChangeOptions, notFound: () => ApiError) {
  return changeRecord(model, recordId, { $set: { deletedAt: new Date(), deletedBy: options.actorId } } as UpdateQuery<Doc>, options, notFound);
}

/** Takes a record back out of the recycle bin. */
export function restoreFromRecycleBin<Doc extends RecordFields>(model: Model<Doc>, recordId: string, options: ChangeOptions, notFound: () => ApiError) {
  return applyChange(model, { _id: recordId, ...ONLY_DELETED }, { $unset: { deletedAt: 1, deletedBy: 1 } } as UpdateQuery<Doc>, options, notFound);
}
