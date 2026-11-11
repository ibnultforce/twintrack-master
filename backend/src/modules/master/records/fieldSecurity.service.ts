import { ApiError } from '../../../lib/errors.js';
import type { Actor } from '../access/caller.js';
import type { FieldChange } from '../models/recordHistory.js';
import { readOwnEntry, type FieldAccessMap } from '../access/permissions.js';
import { listAccessFields, type FieldAccessLevel, type ManifestResource } from '../moduleRegistry/manifest.js';
import { findModuleByKey } from '../moduleRegistry/moduleRegistry.repository.js';

/** The fields of one resource that this person may read and edit, worked out once per request. */
export interface FieldRules {
  hidden: string[];
  readOnly: string[];
  /** Fields this person may set on a new record but not change afterwards. */
  createOnly: string[];
}

/** Whether a write makes a new record or changes one that exists, which decides whether create-only fields may be set. */
export type FieldWrite = 'create' | 'update';

/**
 * Works out the rules from a resource and the person's field access. Every controlled field without a level, or with
 * hidden, is hidden. A super admin may edit every field.
 */
export function buildFieldRules(resource: ManifestResource | undefined, fieldAccess: FieldAccessMap, isSuperAdmin: boolean): FieldRules {
  const fields = resource ? listAccessFields(resource) : [];
  const levelOf = (field: string): FieldAccessLevel | undefined => (isSuperAdmin ? 'edit' : readOwnEntry(fieldAccess, `${resource!.key}.${field}`));
  return {
    hidden: fields.filter((field) => (levelOf(field) ?? 'hidden') === 'hidden'),
    readOnly: fields.filter((field) => levelOf(field) === 'read'),
    createOnly: fields.filter((field) => levelOf(field) === 'create'),
  };
}

/** The fields come from the manifest. Access to them comes from the person's profile. */
export async function readFieldRules(actor: Actor, moduleKey: string, resourceKey: string): Promise<FieldRules> {
  const module = await findModuleByKey(moduleKey);
  const resource = module?.resources.find((candidate) => candidate.key === resourceKey);
  return buildFieldRules(resource, actor.fieldAccess, actor.user.superAdmin);
}

/** Takes hidden fields out of a record before it's sent. */
export function redactRecord<View extends object>(view: View, rules: FieldRules): View {
  if (rules.hidden.length === 0) return view;
  return Object.fromEntries(Object.entries(view).filter(([field]) => !rules.hidden.includes(field))) as View;
}

/** Takes changes to hidden fields out of history entries, so old values can't be read there either. */
export function redactHistory<Entry extends { changes: FieldChange[] }>(entries: Entry[], rules: FieldRules): Entry[] {
  if (rules.hidden.length === 0) return entries;
  return entries.map((entry) => ({ ...entry, changes: entry.changes.filter((change) => !rules.hidden.includes(change.field)) }));
}

/** Refuses a write that sets a field this person can't set in this kind of write. */
export function assertMayWriteFields(rules: FieldRules, fields: string[], write: FieldWrite): void {
  const refused = fields.filter(
    (field) => rules.hidden.includes(field) || rules.readOnly.includes(field) || (write === 'update' && rules.createOnly.includes(field)),
  );
  if (refused.length > 0) {
    const needed = write === 'create' ? 'create or edit access' : 'edit access';
    throw new ApiError(403, 'field_not_editable', `You can't set ${refused.join(', ')} here. That needs ${needed} to the field.`);
  }
}
