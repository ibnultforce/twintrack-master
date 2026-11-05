import { z } from 'zod';
import { asArray, asRecord, fieldErrors, type FieldError, type Validated } from '../lib/validation.js';
import { CONTRACTS, USER_STATUSES } from '../models/user.js';
import { MODULE_KEY, type Manifest } from '../modules/manifest.js';

const moduleKey = z.string().regex(MODULE_KEY, 'must be a module key');

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
  superAdmin: z.boolean().default(false),
  assignments: z.record(moduleKey, z.string()).default({}),
  privileges: z.record(moduleKey, z.array(z.string())).default({}),
});

export type UserRow = z.infer<typeof userRowSchema>;

function grantablePermissions(manifest: Manifest): Set<string> {
  return new Set(
    manifest.resources.flatMap((resource) => (resource.grantable ?? []).map((action) => `${resource.key}.${action}`)),
  );
}

function crossChecks(rows: unknown[], modules: Manifest[]): FieldError[] {
  const errors: FieldError[] = [];
  const manifests = new Map(modules.map((manifest) => [manifest.module.key, manifest]));
  const records = rows.map(asRecord);
  const ids = new Set(records.map((row) => row.id));
  const seenIds = new Set<unknown>();
  const seenEmails = new Set<string>();
  const managerOf = new Map(records.map((row) => [row.id, row.managerId]));

  records.forEach((row, index) => {
    const path = `users.${index}`;
    if (seenIds.has(row.id)) errors.push({ path: `${path}.id`, message: `id "${String(row.id)}" is used twice` });
    seenIds.add(row.id);

    if (typeof row.email === 'string') {
      const email = row.email.toLowerCase();
      if (seenEmails.has(email)) errors.push({ path: `${path}.email`, message: `email "${email}" is used twice` });
      seenEmails.add(email);
    }

    if (row.managerId !== undefined) {
      if (row.managerId === row.id) {
        errors.push({ path: `${path}.managerId`, message: 'a person cannot be their own manager' });
      } else if (!ids.has(row.managerId)) {
        errors.push({ path: `${path}.managerId`, message: `manager "${String(row.managerId)}" is not in this file` });
      } else {
        const visited = new Set<unknown>([row.id]);
        for (let at: unknown = row.managerId; at !== undefined; at = managerOf.get(at)) {
          if (visited.has(at)) {
            errors.push({ path: `${path}.managerId`, message: 'this reporting line goes round in a circle' });
            break;
          }
          visited.add(at);
        }
      }
    }

    // Modules that aren't registered yet are allowed, so access can be set up before they arrive.
    for (const [moduleName, role] of Object.entries(asRecord(row.assignments))) {
      const manifest = manifests.get(moduleName);
      if (manifest && !manifest.roles.some((candidate) => candidate.key === role)) {
        errors.push({ path: `${path}.assignments.${moduleName}`, message: `"${String(role)}" is not a role in ${moduleName}` });
      }
    }
    for (const [moduleName, permissions] of Object.entries(asRecord(row.privileges))) {
      const manifest = manifests.get(moduleName);
      if (!manifest) continue;
      const allowed = grantablePermissions(manifest);
      for (const permission of asArray(permissions)) {
        if (!allowed.has(String(permission))) {
          errors.push({ path: `${path}.privileges.${moduleName}`, message: `"${String(permission)}" can't be granted to one person in ${moduleName}` });
        }
      }
    }
  });
  return errors;
}

/** Checks a whole users file. Any problem rejects the file, so nobody is imported from a bad one. */
export function validateUsersFile(raw: unknown, modules: Manifest[]): Validated<UserRow[]> {
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
  errors.push(...crossChecks(file.users, modules));

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: rows };
}
