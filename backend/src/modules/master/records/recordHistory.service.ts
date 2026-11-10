import { isDeepStrictEqual } from 'node:util';
import type { ClientSession } from 'mongoose';
import { pageOffset, type PageRequest } from '../../../lib/query.js';
import type { Actor } from '../access/caller.js';
import { RecordHistory, type FieldChange, type RecordHistoryDoc } from '../models/recordHistory.js';
import { findModuleByKey } from '../moduleRegistry/moduleRegistry.repository.js';

export interface RecordRef {
  module: string;
  object: string;
  recordId: string;
}

/** Makes a value safe and comparable to store, so a date and its ISO string count as the same. */
const toStoredValue = (value: unknown): unknown => (value instanceof Date ? value.toISOString() : value);

/** The fields the module's manifest asks to track for this resource. Data decides, not code. */
export async function findTrackedFields(moduleKey: string, resourceKey: string, session?: ClientSession): Promise<string[]> {
  const module = await findModuleByKey(moduleKey, session);
  return module?.resources.find((resource) => resource.key === resourceKey)?.trackedFields ?? [];
}

function listChanges(trackedFields: string[], before: Record<string, unknown> | undefined, after: Record<string, unknown> | undefined): FieldChange[] {
  return trackedFields.flatMap((field) => {
    const from = toStoredValue(before?.[field]);
    const to = toStoredValue(after?.[field]);
    if (isDeepStrictEqual(from, to)) return [];
    return [{ field, ...(from !== undefined && { from }), ...(to !== undefined && { to }) }];
  });
}

/**
 * Writes one event to a record's history. Call it inside the transaction that makes the change, so the two are saved
 * together or not at all. An update that changes no tracked field writes nothing.
 */
export async function writeRecordHistory(
  ref: RecordRef,
  event: { action: RecordHistoryDoc['action']; actor: Actor; before?: object; after?: object },
  session: ClientSession,
): Promise<void> {
  const trackedFields = await findTrackedFields(ref.module, ref.object, session);
  const changes = listChanges(trackedFields, event.before as Record<string, unknown>, event.after as Record<string, unknown>);
  if (event.action === 'updated' && changes.length === 0) return;
  await RecordHistory.create(
    [{ ...ref, at: new Date(), action: event.action, changes, actorId: event.actor.user._id, actorName: event.actor.user.name }],
    { session },
  );
}

/** A record's history, newest first. Callers check that the person may read the record before calling this. */
export async function listRecordHistory(ref: RecordRef, page: PageRequest) {
  const filter = { module: ref.module, object: ref.object, recordId: ref.recordId };
  const [entries, total] = await Promise.all([
    RecordHistory.find(filter).sort({ at: -1, _id: -1 }).skip(pageOffset(page)).limit(page.pageSize).lean(),
    RecordHistory.countDocuments(filter),
  ]);
  return {
    total,
    entries: entries.map(({ _id, at, action, changes, actorId, actorName }) => ({ id: String(_id), at, action, changes, actorId, actorName })),
  };
}
