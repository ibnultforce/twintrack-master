import { z } from 'zod';
import { asArray, asRecord, fieldErrors, type FieldError, type Validated } from '../lib/validation.js';

export const MODULE_KEY = /^[a-z][a-z0-9-]*$/;
const ROLE_KEY = /^[a-z][a-z0-9-]*$/;
// Field resources are named after their collection, such as payslip.net.
const RESOURCE_KEY = /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)*$/;
const SEMVER = /^\d+\.\d+\.\d+$/;

export const SCOPES = ['all', 'team', 'own'] as const;
export type Scope = (typeof SCOPES)[number];

const action = z.enum(['read', 'create', 'update', 'delete', 'approve']);
const method = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

const resourceSchema = z.looseObject({
  key: z.string().regex(RESOURCE_KEY, 'must be letters and numbers, starting with a lowercase letter'),
  label: z.string().min(1),
  actions: z.array(action).min(1),
  scoped: z.boolean().optional(),
  grantable: z.array(action).optional(),
});

const routeSchema = z.object({
  method,
  path: z.string().startsWith('/'),
  access: z.enum(['public', 'signed', 'private']),
  permission: z.string().optional(),
  anyPermission: z.array(z.string()).min(1).optional(),
  planned: z.boolean().optional(),
});

const grantSchema = z.object({
  actions: z.array(action).min(1),
  scope: z.enum(SCOPES).optional(),
});

const grantsRecordSchema = z.record(z.string(), grantSchema);

// A plain union would report only "Invalid input" here, without saying which grant is wrong.
const grantsSchema = z
  .unknown()
  .superRefine((value, ctx) => {
    if (value === '*') return;
    const parsed = grantsRecordSchema.safeParse(value);
    if (parsed.success) return;
    for (const issue of parsed.error.issues) {
      ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path.map(String) });
    }
  })
  .transform((value) => value as '*' | z.infer<typeof grantsRecordSchema>);

const roleSchema = z.object({
  key: z.string().regex(ROLE_KEY, 'must be lowercase letters, numbers and hyphens'),
  name: z.string().min(1),
  description: z.string().optional(),
  grants: grantsSchema,
});

const manifestSchema = z.looseObject({
  manifestVersion: z.literal(1),
  module: z.object({
    key: z.string().regex(MODULE_KEY, 'must be lowercase letters, numbers and hyphens, such as "hr"'),
    name: z.string().min(1),
    version: z.string().regex(SEMVER, 'must look like 1.2.0'),
    description: z.string().optional(),
    repository: z.string().optional(),
    baseUrl: z.string().optional(),
    core: z.boolean().optional(),
  }),
  resources: z.array(resourceSchema),
  routes: z.array(routeSchema).default([]),
  roles: z.array(roleSchema),
});

export type Manifest = z.infer<typeof manifestSchema>;
export type ManifestResource = z.infer<typeof resourceSchema>;
export type ManifestRoute = z.infer<typeof routeSchema>;
export type ManifestRole = z.infer<typeof roleSchema>;

function duplicates(items: unknown[], path: string, label: string): FieldError[] {
  const seen = new Set<unknown>();
  const errors: FieldError[] = [];
  items.forEach((item, index) => {
    const key = asRecord(item).key;
    if (key === undefined) return;
    if (seen.has(key)) errors.push({ path: `${path}.${index}.key`, message: `${label} "${String(key)}" is listed twice` });
    seen.add(key);
  });
  return errors;
}

/** Checks that span sections, such as a route naming a permission no resource offers. */
function crossChecks(raw: unknown): FieldError[] {
  const manifest = asRecord(raw);
  const resources = asArray(manifest.resources);
  const routes = asArray(manifest.routes);
  const roles = asArray(manifest.roles);
  const errors = [...duplicates(resources, 'resources', 'Resource'), ...duplicates(roles, 'roles', 'Role')];

  const actionsOf = new Map<string, unknown[]>();
  resources.forEach((item, index) => {
    const resource = asRecord(item);
    const actions = asArray(resource.actions);
    actionsOf.set(String(resource.key), actions);
    for (const granted of asArray(resource.grantable)) {
      if (!actions.includes(granted)) {
        errors.push({ path: `resources.${index}.grantable`, message: `"${String(granted)}" is not an action of this resource` });
      }
    }
  });

  const checkPermission = (permission: unknown, path: string) => {
    if (typeof permission !== 'string') return;
    const dot = permission.lastIndexOf('.');
    if (dot > 0 && actionsOf.get(permission.slice(0, dot))?.includes(permission.slice(dot + 1))) return;
    errors.push({ path, message: `permission "${permission}" is not an action of any resource` });
  };

  const seenRoutes = new Set<string>();
  routes.forEach((item, index) => {
    const route = asRecord(item);
    const id = `${String(route.method)} ${String(route.path)}`;
    if (seenRoutes.has(id)) errors.push({ path: `routes.${index}`, message: `route ${id} is listed twice` });
    seenRoutes.add(id);

    checkPermission(route.permission, `routes.${index}.permission`);
    asArray(route.anyPermission).forEach((permission) => checkPermission(permission, `routes.${index}.anyPermission`));
    if (route.access === 'private' && route.permission === undefined && route.anyPermission === undefined) {
      errors.push({ path: `routes.${index}`, message: 'a private route needs a permission' });
    }
  });

  roles.forEach((item, index) => {
    const grants = asRecord(asRecord(item).grants);
    for (const [resourceKey, grant] of Object.entries(grants)) {
      const path = `roles.${index}.grants.${resourceKey}`;
      const actions = actionsOf.get(resourceKey);
      if (!actions) {
        errors.push({ path, message: `"${resourceKey}" is not a resource of this module` });
        continue;
      }
      for (const granted of asArray(asRecord(grant).actions)) {
        if (!actions.includes(granted)) errors.push({ path, message: `"${String(granted)}" is not an action of "${resourceKey}"` });
      }
    }
  });

  return errors;
}

export function validateManifest(raw: unknown): Validated<Manifest> {
  const parsed = manifestSchema.safeParse(raw);
  const errors = [...(parsed.success ? [] : fieldErrors(parsed.error.issues)), ...crossChecks(raw)];
  if (!parsed.success || errors.length > 0) return { ok: false, errors };
  return { ok: true, value: parsed.data };
}
