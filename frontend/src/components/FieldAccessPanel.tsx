'use client';

import { FIELD_ACCESS_LEVELS, type FieldAccessLevel, type FieldAccessMap, type ModuleResource } from '@/lib/api/types';
import { humanize } from '@/lib/format';
import { impliedFieldLevel, listAccessFields, permissionKey, widestUsefulFieldLevel } from '@/lib/grants';

/** The action that makes each level useful, for explaining why a level can't be picked yet. */
const ACTION_NEEDED: Partial<Record<FieldAccessLevel, string>> = { read: 'Read', create: 'Create', edit: 'Update' };

const isWiderLevel = (candidate: FieldAccessLevel, limit: FieldAccessLevel) => FIELD_ACCESS_LEVELS.indexOf(candidate) > FIELD_ACCESS_LEVELS.indexOf(limit);

export const FIELD_LEVEL_LABELS: Record<FieldAccessLevel, string> = { hidden: 'Hidden', read: 'Read', create: 'Create only', edit: 'Edit' };

/**
 * A table row under one resource in the grants grid, holding the access level of each of its fields. A field on Auto
 * follows the ticked actions, so only the fields someone sets are saved.
 */
export function FieldAccessPanel({ resource, columnCount, selectedActions, fieldAccess, assignableFields, canEdit, onChange }: {
  resource: ModuleResource;
  /** How many columns the grid has, so the row spans all of them. */
  columnCount: number;
  selectedActions: string[];
  fieldAccess: FieldAccessMap;
  /** The levels this person may give. Null means any, for a super admin. */
  assignableFields: FieldAccessMap | null;
  canEdit: boolean;
  onChange: (next: FieldAccessMap) => void;
}) {
  const fields = listAccessFields(resource);
  if (fields.length === 0) return null;

  const keyOf = (field: string) => permissionKey(resource.key, field);
  const hasAccess = selectedActions.length > 0;
  const isEditable = canEdit && hasAccess;
  const statedCount = fields.filter((field) => fieldAccess[keyOf(field)]).length;
  // A level beyond the ticked actions would do nothing: nobody can create a field on a record they can't create.
  const widestUseful = widestUsefulFieldLevel(selectedActions);

  /** Why a level can't be given on a field, or undefined when it can. Hidden takes access away, so it's always allowed. */
  const blockedReason = (field: string, level: FieldAccessLevel): string | undefined => {
    if (isWiderLevel(level, widestUseful)) return `Tick ${ACTION_NEEDED[level]} on ${resource.label} to use this`;
    const held = assignableFields === null ? 'edit' : assignableFields[keyOf(field)];
    if (level !== 'hidden' && (held === undefined || isWiderLevel(level, held))) return 'Beyond your own access to this field';
    return undefined;
  };

  const setLevel = (field: string, level: FieldAccessLevel | null) => {
    const next = { ...fieldAccess };
    if (level) next[keyOf(field)] = level;
    else delete next[keyOf(field)];
    onChange(next);
  };

  /** Sets every field to one level, or back to Auto. Fields that can't take the level keep theirs. */
  const setAllFields = (level: FieldAccessLevel | null) => {
    const next = { ...fieldAccess };
    for (const field of fields) {
      if (!level) delete next[keyOf(field)];
      else if (!blockedReason(field, level)) next[keyOf(field)] = level;
    }
    onChange(next);
  };
  const allFieldsAt = (level: FieldAccessLevel | null) => fields.every((field) => (fieldAccess[keyOf(field)] ?? null) === level);

  return (
    <tr className="field-row">
      <td colSpan={columnCount}>
        <details className="field-panel" open>
          <summary>
            {resource.label} fields
            <span className="meta"> · {fields.length} fields{statedCount > 0 ? `, ${statedCount} set by hand` : ', all on Auto'}</span>
          </summary>
          {hasAccess ? (
            <>
              <p className="note">
                <strong>Auto</strong> follows the ticked actions: Read gives Read, Create gives Create only, Update gives Edit. Pick a level to fix a field whatever the actions say.
              </p>
              <div className="field-access-list">
                {fields.map((field) => {
                  const stated = fieldAccess[keyOf(field)];
                  const autoLevel = impliedFieldLevel(resource, field, selectedActions);
                  return (
                    <div className="field-item" key={field}>
                      <span className="field-name">
                        {humanize(field)}
                        {resource.protectedFields?.includes(field) ? <span className="field-tag">Protected</span> : null}
                      </span>
                      <div className="segmented" role="group" aria-label={`${humanize(field)} access`}>
                        <button type="button" aria-pressed={!stated} disabled={!isEditable} onClick={() => setLevel(field, null)}>
                          Auto <span className="auto-result">{FIELD_LEVEL_LABELS[autoLevel]}</span>
                        </button>
                        {FIELD_ACCESS_LEVELS.map((level) => {
                          const reason = blockedReason(field, level);
                          return (
                            <button key={level} type="button" title={reason} aria-pressed={stated === level} disabled={!isEditable || Boolean(reason)} onClick={() => setLevel(field, level)}>
                              {FIELD_LEVEL_LABELS[level]}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
                <div className="field-item field-item-all">
                  <span className="field-name">All fields</span>
                  <div className="segmented" role="group" aria-label={`Set every ${resource.label} field`}>
                    <button type="button" aria-pressed={allFieldsAt(null)} disabled={!isEditable} onClick={() => setAllFields(null)}>Auto</button>
                    {FIELD_ACCESS_LEVELS.map((level) => {
                      const isUsable = fields.some((field) => !blockedReason(field, level));
                      return (
                        <button key={level} type="button" title={isUsable ? undefined : blockedReason(fields[0]!, level)} aria-pressed={allFieldsAt(level)} disabled={!isEditable || !isUsable} onClick={() => setAllFields(level)}>
                          {FIELD_LEVEL_LABELS[level]}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </>
          ) : (
            <p className="note">Tick Read, Create or Update on {resource.label} first. Fields follow those actions, and there&apos;s nothing to see without them.</p>
          )}
        </details>
      </td>
    </tr>
  );
}
