import { z } from 'zod';
import { asRecord, fieldErrors, type FieldError, type Validated } from '../../../lib/validation.js';
import { CONTRACTS, USER_STATUSES } from '../models/user.js';


const userRowSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/, 'must be letters, numbers, hyphens and underscores'),
  name: z.string().trim().min(1, 'is required'),
  email: z.email('must be a valid email address').toLowerCase(),
  title: z.string().optional(),
  department: z.string().optional(),
  team: z.string().optional(),
  contract: z.enum(CONTRACTS).default('permanent'),
  status: z.enum(USER_STATUSES).default('active'),
  managerId: z.string().optional(),
  orgRoleId: z.string().optional(),
  superAdmin: z.boolean().default(false),
  profileId: z.string().optional(),
});

export type UserRow = z.infer<typeof userRowSchema>;

type RawRow = Record<string, unknown>;

function checkUniqueIdsAndEmails(rows: RawRow[]): FieldError[] {
  const errors: FieldError[] = [];
  const seenIds = new Set<unknown>();
  const seenEmails = new Set<string>();

  rows.forEach((row, index) => {
    if (seenIds.has(row.id)) errors.push({ path: `users.${index}.id`, message: `id "${String(row.id)}" is used twice` });
    seenIds.add(row.id);

    if (typeof row.email !== 'string') return;
    const email = row.email.toLowerCase();
    if (seenEmails.has(email)) errors.push({ path: `users.${index}.email`, message: `email "${email}" is used twice` });
    seenEmails.add(email);
  });
  return errors;
}

function reportingLineHasCircle(row: RawRow, managerOf: Map<unknown, unknown>): boolean {
  const visitedIds = new Set<unknown>([row.id]);
  for (let currentId = row.managerId; currentId !== undefined; currentId = managerOf.get(currentId)) {
    if (visitedIds.has(currentId)) return true;
    visitedIds.add(currentId);
  }
  return false;
}

function checkManagers(rows: RawRow[]): FieldError[] {
  const errors: FieldError[] = [];
  const managerOf = new Map(rows.map((row) => [row.id, row.managerId]));

  rows.forEach((row, index) => {
    if (row.managerId === undefined) return;
    const path = `users.${index}.managerId`;
    if (row.managerId === row.id) {
      errors.push({ path, message: 'a person cannot be their own manager' });
    } else if (!managerOf.has(row.managerId)) {
      errors.push({ path, message: `manager "${String(row.managerId)}" is not in this file` });
    } else if (reportingLineHasCircle(row, managerOf)) {
      errors.push({ path, message: 'this reporting line goes round in a circle' });
    }
  });
  return errors;
}

function checkProfiles(rows: RawRow[], profileIds: Set<string> | undefined): FieldError[] {
  if (!profileIds) return [];
  const errors: FieldError[] = [];
  rows.forEach((row, index) => {
    if (row.profileId !== undefined && !profileIds.has(String(row.profileId))) {
      errors.push({ path: `users.${index}.profileId`, message: `profile "${String(row.profileId)}" is not in the profiles file` });
    }
  });
  return errors;
}

function checkOrgRoles(rows: RawRow[], orgRoleIds: Set<string> | undefined): FieldError[] {
  if (!orgRoleIds) return [];
  const errors: FieldError[] = [];
  rows.forEach((row, index) => {
    if (row.orgRoleId !== undefined && !orgRoleIds.has(String(row.orgRoleId))) {
      errors.push({ path: `users.${index}.orgRoleId`, message: `org role "${String(row.orgRoleId)}" is not in the org roles file` });
    }
  });
  return errors;
}

function crossChecks(rawRows: unknown[], related: RelatedIds): FieldError[] {
  const rows = rawRows.map(asRecord);
  return [
    ...checkUniqueIdsAndEmails(rows),
    ...checkManagers(rows),
    ...checkOrgRoles(rows, related.orgRoleIds),
    ...checkProfiles(rows, related.profileIds),
    ...rows.flatMap((row, index) =>
      row.permissionSets === undefined ? [] : [{ path: `users.${index}.permissionSets`, message: 'permission sets were removed: give the person a profileId' }],
    ),
  ];
}

/** The ids of org roles and profiles loaded alongside the people. Each set left out isn't checked. */
export interface RelatedIds {
  orgRoleIds?: Set<string>;
  profileIds?: Set<string>;
}

/** Checks a whole users file. Any problem rejects the file, so nobody is imported from a bad one. */
export function validateUsersFile(raw: unknown, related: RelatedIds = {}): Validated<UserRow[]> {
  const file = asRecord(raw);
  if (file.type !== 'users' || !Array.isArray(file.users)) {
    return { ok: false, errors: [{ path: '', message: 'expected { "type": "users", "users": [...] }' }] };
  }

  const rows: UserRow[] = [];
  const errors: FieldError[] = [];
  file.users.forEach((row: unknown, index: number) => {
    const parsed = userRowSchema.safeParse(row);
    if (parsed.success) rows.push(parsed.data);
    else errors.push(...fieldErrors(parsed.error.issues, `users.${index}`));
  });
  errors.push(...crossChecks(file.users, related));

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: rows };
}
