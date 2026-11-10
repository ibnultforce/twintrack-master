import { ApiError } from '../../../lib/errors.js';
import type { Actor } from '../access/caller.js';
import type { FieldChange } from '../models/recordHistory.js';
import { findModuleByKey } from '../moduleRegistry/moduleRegistry.repository.js';

/** The fields of one resource that this person may read and edit, worked out once per request. */
export interface FieldRules {
  hidden: string[];
  readOnly: string[];
}

/** Protected fields come from the manifest. Access to them comes from the person's profile and permission sets. */
export async function readFieldRules(actor: Actor, moduleKey: string, resourceKey: string): Promise<FieldRules> {
  const module = await findModuleByKey(moduleKey);
  const protectedFields = module?.resources.find((resource) => resource.key === resourceKey)?.protectedFields ?? [];
  const levelOf = (field: string) => (actor.user.superAdmin ? 'edit' : actor.fieldAccess[`${resourceKey}.${field}`]);
  return {
    hidden: protectedFields.filter((field) => !levelOf(field)),
    readOnly: protectedFields.filter((field) => levelOf(field) === 'read'),
  };
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

/** Refuses a write that sets a protected field this person can't edit. */
export function assertMayWriteFields(rules: FieldRules, fields: string[]): void {
  const refused = fields.filter((field) => rules.hidden.includes(field) || rules.readOnly.includes(field));
  if (refused.length > 0) {
    throw new ApiError(403, 'field_not_editable', `You can't set ${refused.join(', ')} here. That needs edit access to the field.`);
  }
}
