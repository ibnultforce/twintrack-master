import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import { z } from 'zod';
import { runInTransaction } from '../../../db.js';
import { ApiError } from '../../../lib/errors.js';
import { pageOffset, type PageRequest } from '../../../lib/query.js';
import { ONLY_DELETED, WITH_DELETED } from '../../../lib/records/recordFields.js';
import { changeRecord, moveToRecycleBin, restoreFromRecycleBin } from '../../../lib/records/recordWrites.js';
import { fieldErrors } from '../../../lib/validation.js';
import { actorFields, type Actor, type Caller } from '../access/caller.js';
import { resolveModuleAccess } from '../access/permissions.js';
import { peopleInScope } from '../access/scope.js';
import { recordAudit } from '../audit/audit.repository.js';
import { CustomRecord, type CustomRecordDoc } from '../models/customRecord.js';
import type { Scope } from '../moduleRegistry/manifest.js';
import { findAllModules, findModuleByKey } from '../moduleRegistry/moduleRegistry.repository.js';
import {
  assertCanReachRecord,
  findSharedRecordIds,
  findSharingModel,
  listRecordShares,
  shareRecord,
  unshareRecord,
  type RecordNeed,
  type ShareInput,
} from '../records/recordAccess.service.js';
import { assertMayWriteFields, readFieldRules, redactHistory, type FieldRules } from '../records/fieldSecurity.service.js';
import { listRecordHistory, writeRecordHistory } from '../records/recordHistory.service.js';
import { findCustomObject, type FieldDefinition } from './customObjects.service.js';

/** The actions a custom record route can need, as the permission each one checks. */
type ObjectAction = 'read' | 'create' | 'update' | 'delete';

/** Who is asking, with their permissions in the record's module, worked out from data on each request. */
interface ObjectContext {
  actor: Actor;
  scope: Scope;
  moduleKey: string;
  objectKey: string;
  fields: FieldDefinition[];
  rules: FieldRules;
}

const MAX_TEXT_LENGTH = 2000;

/**
 * The custom objects this person can read, with the fields they may see and what else they can do.
 * Screens use it to build forms, so protected fields the person can't see are left out.
 */
export async function listReadableObjects(caller: Caller) {
  const modules = await findAllModules();
  return modules.flatMap((module) => {
    const access = resolveModuleAccess(caller, module);
    return module.resources
      .filter((resource) => resource.custom === true && access.permissions[`${resource.key}.read`])
      .map((resource) => {
        const levelOf = (field: string) => (caller.user.superAdmin ? 'edit' : access.fieldAccess[`${resource.key}.${field}`]);
        const fields = ((resource.fields ?? []) as FieldDefinition[])
          .filter((field) => !field.protected || levelOf(field.key))
          .map((field) => ({ ...field, editable: !field.protected || levelOf(field.key) === 'edit' }));
        return {
          module: module.key,
          moduleName: module.name,
          key: resource.key,
          label: resource.label,
          fields,
          can: {
            create: Boolean(access.permissions[`${resource.key}.create`]),
            update: Boolean(access.permissions[`${resource.key}.update`]),
            delete: Boolean(access.permissions[`${resource.key}.delete`]),
          },
        };
      });
  });
}

const recordNotFound = () => new ApiError(404, 'unknown_record', 'No such record.');

/**
 * Checks the caller's permission for an action on a custom object, as the access middleware does for built routes.
 * These routes are signed because the module comes from the path.
 */
export async function openObject(caller: Caller, ipAddress: string | undefined, moduleKey: string, objectKey: string, action: ObjectAction): Promise<ObjectContext> {
  const module = await findModuleByKey(moduleKey);
  if (!module) throw new ApiError(404, 'unknown_module', 'No such module.');
  const object = findCustomObject(module, objectKey);
  const access = resolveModuleAccess(caller, module);
  const scope = access.permissions[`${objectKey}.${action}`];
  if (!scope) throw new ApiError(403, 'forbidden', 'You do not have permission to do this.');

  const actor: Actor = { user: caller.user, profile: caller.profile, ipAddress, permissions: access.permissions, fieldAccess: access.fieldAccess };
  return { actor, scope, moduleKey, objectKey, fields: object.fields, rules: await readFieldRules(actor, moduleKey, objectKey) };
}

function valueSchemaFor(field: FieldDefinition) {
  switch (field.type) {
    case 'number':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'date':
      return z.iso.date('must be a date, such as 2026-12-01');
    case 'select':
      return z.enum(field.options as [string, ...string[]]);
    default:
      return z.string().trim().max(MAX_TEXT_LENGTH);
  }
}

/** Checks values against the object's field definitions. A new record needs every required field. */
function parseValues(fields: FieldDefinition[], raw: unknown, { isNew }: { isNew: boolean }): Record<string, unknown> {
  const shape = Object.fromEntries(fields.map((field) => {
    const schema = valueSchemaFor(field);
    return [field.key, isNew && field.required ? schema : schema.nullable().optional()];
  }));
  const parsed = z.strictObject(shape).safeParse(raw ?? {});
  if (!parsed.success) throw new ApiError(422, 'validation_failed', 'Some fields are invalid.', fieldErrors(parsed.error.issues, 'values'));
  if (!isNew) {
    for (const field of fields) {
      if (field.required && parsed.data[field.key] === null) {
        throw new ApiError(422, 'validation_failed', 'Some fields are invalid.', [{ path: `values.${field.key}`, message: 'is required' }]);
      }
    }
  }
  return parsed.data;
}

const historyRef = (context: ObjectContext, recordId: string) => ({ module: context.moduleKey, object: context.objectKey, recordId });
const scopedRecord = (context: ObjectContext, record: CustomRecordDoc) => ({ ...historyRef(context, record._id), peopleIds: [record.ownerId] });

/** The record as this person may see it: values of removed fields and of hidden protected fields are left out. */
function toRecordView(context: ObjectContext, record: CustomRecordDoc) {
  const known = new Set(context.fields.map((field) => field.key));
  const values = Object.fromEntries(Object.entries(record.values ?? {}).filter(([key]) => known.has(key) && !context.rules.hidden.includes(key)));
  return {
    id: record._id,
    module: record.module,
    object: record.object,
    ownerId: record.ownerId,
    values,
    version: record.version,
    createdBy: record.createdBy,
    createdAt: record.createdAt,
    updatedBy: record.updatedBy,
    updatedAt: record.updatedAt,
    ...(record.deletedAt && { deletedAt: record.deletedAt, deletedBy: record.deletedBy }),
  };
}

async function requireRecord(context: ObjectContext, recordId: string, need: RecordNeed | 'scope', options: { withDeleted?: boolean } = {}): Promise<CustomRecordDoc> {
  const record = await CustomRecord.findOne({ _id: recordId, module: context.moduleKey, object: context.objectKey })
    .setOptions(options.withDeleted ? WITH_DELETED : {})
    .lean<CustomRecordDoc>();
  if (!record) throw recordNotFound();
  if (need === 'scope') {
    const reached = await peopleInScope(context.actor.user._id, context.scope);
    if (reached && !reached.includes(record.ownerId)) throw new ApiError(403, 'out_of_scope', 'This record is outside what your access reaches.');
  } else {
    await assertCanReachRecord(context.actor, context.scope, scopedRecord(context, record), need);
  }
  return record;
}

const auditFields = (context: ObjectContext, recordId: string) => ({
  ...actorFields(context.actor),
  targetType: context.objectKey,
  targetId: recordId,
  module: context.moduleKey,
});

export async function listCustomRecords(context: ObjectContext, page: PageRequest & { deleted?: boolean }) {
  const { deleted = false, ...pageRequest } = page;
  if (deleted && !context.actor.permissions[`${context.objectKey}.delete`]) {
    throw new ApiError(403, 'forbidden', `Seeing deleted records needs ${context.objectKey}.delete.`);
  }
  const sharingModel = await findSharingModel(context.moduleKey, context.objectKey);
  const ownerIds = sharingModel === 'private' ? await peopleInScope(context.actor.user._id, context.scope) : null;
  const sharedIds = ownerIds ? await findSharedRecordIds(context.actor.user, context.moduleKey, context.objectKey, 'read') : [];
  const filter = {
    module: context.moduleKey,
    object: context.objectKey,
    ...(ownerIds && { $or: [{ ownerId: { $in: ownerIds } }, { _id: { $in: sharedIds } }] }),
    ...(deleted && ONLY_DELETED),
  };
  const [records, total] = await Promise.all([
    CustomRecord.find(filter).sort({ createdAt: -1, _id: 1 }).skip(pageOffset(pageRequest)).limit(pageRequest.pageSize).lean<CustomRecordDoc[]>(),
    CustomRecord.countDocuments(filter),
  ]);
  return { scope: context.scope, total, records: records.map((record) => toRecordView(context, record)) };
}

export async function getCustomRecord(context: ObjectContext, recordId: string) {
  return toRecordView(context, await requireRecord(context, recordId, 'read'));
}

/** The caller owns the new record. */
export async function createCustomRecord(context: ObjectContext, rawValues: unknown) {
  const values = parseValues(context.fields, rawValues, { isNew: true });
  assertMayWriteFields(context.rules, Object.keys(values));
  const actorId = context.actor.user._id;
  const record = await runInTransaction(async (session) => {
    const [created] = await CustomRecord.create(
      [{ _id: `cr_${randomUUID()}`, module: context.moduleKey, object: context.objectKey, ownerId: actorId, values, createdBy: actorId, updatedBy: actorId }],
      { session },
    );
    const saved = created!.toObject();
    await writeRecordHistory(historyRef(context, saved._id), { action: 'created', actor: context.actor, after: saved.values }, session);
    await recordAudit({ action: `${context.objectKey}.created`, ...auditFields(context, saved._id) }, session);
    return saved;
  });
  return toRecordView(context, record);
}

/** Runs one change with its history and activity log entry in the same transaction. */
async function changeCustomRecord(
  context: ObjectContext,
  recordId: string,
  change: { need: RecordNeed | 'scope'; auditAction: string; historyAction: 'updated' | 'deleted' | 'restored'; withDeleted?: boolean; save: (existing: CustomRecordDoc, session: ClientSession) => Promise<CustomRecordDoc> },
) {
  const existing = await requireRecord(context, recordId, change.need, { withDeleted: change.withDeleted });
  const saved = await runInTransaction(async (session) => {
    const result = await change.save(existing, session);
    await writeRecordHistory(historyRef(context, recordId), { action: change.historyAction, actor: context.actor, before: existing.values, after: result.values }, session);
    await recordAudit({ action: `${context.objectKey}.${change.auditAction}`, ...auditFields(context, recordId) }, session);
    return result;
  });
  return toRecordView(context, saved);
}

export function updateCustomRecord(context: ObjectContext, recordId: string, rawValues: unknown, version?: number) {
  const values = parseValues(context.fields, rawValues, { isNew: false });
  if (Object.keys(values).length === 0) throw new ApiError(422, 'validation_failed', 'Some fields are invalid.', [{ path: 'values', message: 'send at least one field to change' }]);
  return changeCustomRecord(context, recordId, {
    need: 'edit',
    auditAction: 'updated',
    historyAction: 'updated',
    save: (_existing, session) => {
      // Checked after the reach check, so someone outside it learns nothing about the fields.
      assertMayWriteFields(context.rules, Object.keys(values));
      const toSet = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null).map(([key, value]) => [`values.${key}`, value]));
      const toUnset = Object.fromEntries(Object.entries(values).filter(([, value]) => value === null).map(([key]) => [`values.${key}`, 1]));
      return changeRecord(CustomRecord, recordId, { $set: toSet, ...(Object.keys(toUnset).length > 0 && { $unset: toUnset }) }, { actorId: context.actor.user._id, expectedVersion: version, session }, recordNotFound);
    },
  });
}

export function deleteCustomRecord(context: ObjectContext, recordId: string) {
  return changeCustomRecord(context, recordId, {
    need: 'scope',
    auditAction: 'deleted',
    historyAction: 'deleted',
    save: (_existing, session) => moveToRecycleBin(CustomRecord, recordId, { actorId: context.actor.user._id, session }, recordNotFound),
  });
}

export function restoreCustomRecord(context: ObjectContext, recordId: string) {
  return changeCustomRecord(context, recordId, {
    need: 'scope',
    auditAction: 'restored',
    historyAction: 'restored',
    withDeleted: true,
    save: (_existing, session) => restoreFromRecycleBin(CustomRecord, recordId, { actorId: context.actor.user._id, session }, recordNotFound),
  });
}

export async function getCustomRecordHistory(context: ObjectContext, recordId: string, page: PageRequest) {
  await requireRecord(context, recordId, 'read', { withDeleted: Boolean(context.actor.permissions[`${context.objectKey}.delete`]) });
  const history = await listRecordHistory(historyRef(context, recordId), page);
  return { ...history, entries: redactHistory(history.entries, context.rules) };
}

export async function listCustomRecordShares(context: ObjectContext, recordId: string) {
  await requireRecord(context, recordId, 'read');
  return listRecordShares(historyRef(context, recordId));
}

async function findForSharing(context: ObjectContext, recordId: string) {
  const record = await CustomRecord.findOne({ _id: recordId, module: context.moduleKey, object: context.objectKey }).lean<CustomRecordDoc>();
  if (!record) throw recordNotFound();
  return scopedRecord(context, record);
}

export async function shareCustomRecord(context: ObjectContext, recordId: string, input: ShareInput) {
  return shareRecord(context.actor, await findForSharing(context, recordId), input);
}

export async function unshareCustomRecord(context: ObjectContext, recordId: string, shareId: string) {
  return unshareRecord(context.actor, await findForSharing(context, recordId), shareId);
}
