import { z } from 'zod';
import { asArray, asRecord, fieldErrors, type FieldError, type Validated } from '../../../lib/validation.js';

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
  .superRefine((value, context) => {
    if (value === '*') return;
    const parsed = grantsRecordSchema.safeParse(value);
    if (parsed.success) return;
    for (const issue of parsed.error.issues) {
      context.addIssue({ code: 'custom', message: issue.message, path: issue.path.map(String) });
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

type ActionsByResource = Map<string, unknown[]>;

function findDuplicateKeys(items: unknown[], path: string, label: string): FieldError[] {
  const seenKeys = new Set<unknown>();
  const errors: FieldError[] = [];
  items.forEach((item, index) => {
    const key = asRecord(item).key;
    if (key === undefined) return;
    if (seenKeys.has(key)) errors.push({ path: `${path}.${index}.key`, message: `${label} "${String(key)}" is listed twice` });
    seenKeys.add(key);
  });
  return errors;
}

function readActionsByResource(resources: unknown[]): ActionsByResource {
  return new Map(
    resources.map((item) => {
      const resource = asRecord(item);
      return [String(resource.key), asArray(resource.actions)];
    }),
  );
}

function checkGrantableActions(resources: unknown[]): FieldError[] {
  const errors: FieldError[] = [];
  resources.forEach((item, index) => {
    const resource = asRecord(item);
    const actions = asArray(resource.actions);
    for (const grantableAction of asArray(resource.grantable)) {
      if (!actions.includes(grantableAction)) {
        errors.push({ path: `resources.${index}.grantable`, message: `"${String(grantableAction)}" is not an action of this resource` });
      }
    }
  });
  return errors;
}

function checkPermissionExists(permission: unknown, path: string, actionsByResource: ActionsByResource): FieldError[] {
  if (typeof permission !== 'string') return [];
  const lastDot = permission.lastIndexOf('.');
  const resourceKey = permission.slice(0, lastDot);
  const actionName = permission.slice(lastDot + 1);
  if (lastDot > 0 && actionsByResource.get(resourceKey)?.includes(actionName)) return [];
  return [{ path, message: `permission "${permission}" is not an action of any resource` }];
}

function checkRoutes(routes: unknown[], actionsByResource: ActionsByResource): FieldError[] {
  const errors: FieldError[] = [];
  const seenRoutes = new Set<string>();
  routes.forEach((item, index) => {
    const route = asRecord(item);
    const routeId = `${String(route.method)} ${String(route.path)}`;
    if (seenRoutes.has(routeId)) errors.push({ path: `routes.${index}`, message: `route ${routeId} is listed twice` });
    seenRoutes.add(routeId);

    errors.push(...checkPermissionExists(route.permission, `routes.${index}.permission`, actionsByResource));
    for (const permission of asArray(route.anyPermission)) {
      errors.push(...checkPermissionExists(permission, `routes.${index}.anyPermission`, actionsByResource));
    }
    if (route.access === 'private' && route.permission === undefined && route.anyPermission === undefined) {
      errors.push({ path: `routes.${index}`, message: 'a private route needs a permission' });
    }
  });
  return errors;
}

function checkRoleGrants(roles: unknown[], actionsByResource: ActionsByResource): FieldError[] {
  const errors: FieldError[] = [];
  roles.forEach((item, index) => {
    const grants = asRecord(asRecord(item).grants);
    for (const [resourceKey, grant] of Object.entries(grants)) {
      const path = `roles.${index}.grants.${resourceKey}`;
      const actions = actionsByResource.get(resourceKey);
      if (!actions) {
        errors.push({ path, message: `"${resourceKey}" is not a resource of this module` });
        continue;
      }
      for (const grantedAction of asArray(asRecord(grant).actions)) {
        if (!actions.includes(grantedAction)) errors.push({ path, message: `"${String(grantedAction)}" is not an action of "${resourceKey}"` });
      }
    }
  });
  return errors;
}

/** Checks that span sections, such as a route naming a permission no resource offers. */
function crossChecks(raw: unknown): FieldError[] {
  const manifest = asRecord(raw);
  const resources = asArray(manifest.resources);
  const routes = asArray(manifest.routes);
  const roles = asArray(manifest.roles);
  const actionsByResource = readActionsByResource(resources);

  return [
    ...findDuplicateKeys(resources, 'resources', 'Resource'),
    ...findDuplicateKeys(roles, 'roles', 'Role'),
    ...checkGrantableActions(resources),
    ...checkRoutes(routes, actionsByResource),
    ...checkRoleGrants(roles, actionsByResource),
  ];
}

export function validateManifest(raw: unknown): Validated<Manifest> {
  const parsed = manifestSchema.safeParse(raw);
  const errors = [...(parsed.success ? [] : fieldErrors(parsed.error.issues)), ...crossChecks(raw)];
  if (!parsed.success || errors.length > 0) return { ok: false, errors };
  return { ok: true, value: parsed.data };
}
