import { z } from 'zod';
import { asRecord, fieldErrors, type FieldError, type Validated } from '../../../lib/validation.js';
import type { OrgRoleSeedRow } from './orgRoles.repository.js';

const orgRoleRowSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/, 'must be letters, numbers, hyphens and underscores'),
  name: z.string().trim().min(1, 'is required'),
  description: z.string().trim().min(1).optional(),
  parentId: z.string().optional(),
});

type OrgRoleRow = z.infer<typeof orgRoleRowSchema>;

/** Follows each role's parents up to the root, so a circle or a missing parent is reported instead of looping. */
function findAncestors(row: OrgRoleRow, byId: Map<string, OrgRoleRow>): string[] | 'circle' | 'missing_parent' {
  const ancestorIds: string[] = [];
  for (let parentId = row.parentId; parentId !== undefined; parentId = byId.get(parentId)?.parentId) {
    if (parentId === row.id || ancestorIds.includes(parentId)) return 'circle';
    if (!byId.has(parentId)) return 'missing_parent';
    ancestorIds.unshift(parentId);
  }
  return ancestorIds;
}

function checkTree(rows: OrgRoleRow[]): { errors: FieldError[]; records: OrgRoleSeedRow[] } {
  const errors: FieldError[] = [];
  const byId = new Map<string, OrgRoleRow>();
  rows.forEach((row, index) => {
    if (byId.has(row.id)) errors.push({ path: `orgRoles.${index}.id`, message: `id "${row.id}" is used twice` });
    byId.set(row.id, row);
  });

  const rootCount = rows.filter((row) => row.parentId === undefined).length;
  if (rows.length > 0 && rootCount !== 1) errors.push({ path: 'orgRoles', message: `the tree needs exactly one role with no parent, not ${rootCount}` });

  const records: OrgRoleSeedRow[] = [];
  rows.forEach((row, index) => {
    const ancestors = findAncestors(row, byId);
    const path = `orgRoles.${index}.parentId`;
    if (ancestors === 'circle') errors.push({ path, message: 'this line of parents goes round in a circle' });
    else if (ancestors === 'missing_parent') errors.push({ path, message: `parent "${String(row.parentId)}" is not in this file` });
    else records.push({ _id: row.id, name: row.name, description: row.description, parentId: row.parentId, ancestorIds: ancestors, ...(row.parentId === undefined && { isRoot: true as const }) });
  });
  return { errors, records };
}

/** Checks a whole org roles file. Any problem rejects the file, so a broken tree is never loaded. */
export function validateOrgRolesFile(raw: unknown): Validated<OrgRoleSeedRow[]> {
  const file = asRecord(raw);
  if (file.type !== 'orgRoles' || !Array.isArray(file.orgRoles)) {
    return { ok: false, errors: [{ path: '', message: 'expected { "type": "orgRoles", "orgRoles": [...] }' }] };
  }

  const rows: OrgRoleRow[] = [];
  const errors: FieldError[] = [];
  file.orgRoles.forEach((row: unknown, index: number) => {
    const parsed = orgRoleRowSchema.safeParse(row);
    if (parsed.success) rows.push(parsed.data);
    else errors.push(...fieldErrors(parsed.error.issues, `orgRoles.${index}`));
  });
  if (errors.length > 0) return { ok: false, errors };

  const tree = checkTree(rows);
  return tree.errors.length > 0 ? { ok: false, errors: tree.errors } : { ok: true, value: tree.records };
}
