import { z } from 'zod';
import { asArray, asRecord, fieldErrors, type FieldError, type Validated } from '../../../lib/validation.js';

// People's access is stored in plain objects keyed by module, where "constructor" would find a JavaScript built-in.
export const MODULE_KEY = /^(?!constructor$)[a-z][a-z0-9-]*$/;
const PERMISSION_SET_KEY = /^[a-z][a-z0-9-]*$/;
// Field resources are named after their collection, such as payslip.net.
const RESOURCE_KEY = /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)*$/;
const SEMVER = /^\d+\.\d+\.\d+$/;

export const MASTER_MODULE_KEY = 'master';

export const SCOPES = ['all', 'team', 'own'] as const;
export type Scope = (typeof SCOPES)[number];

const action = z.enum(['read', 'create', 'update', 'delete', 'approve', 'share']);

export const SHARING_MODELS = ['private', 'publicRead', 'publicReadWrite'] as const;
export const FIELD_ACCESS = ['read', 'edit'] as const;
export type FieldAccessLevel = (typeof FIELD_ACCESS)[number];
const FIELD_NAME = /^[a-zA-Z][a-zA-Z0-9]*$/;
export type SharingModel = (typeof SHARING_MODELS)[number];
const method = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

const resourceSchema = z.looseObject({
  key: z.string().regex(RESOURCE_KEY, 'must be letters and numbers, starting with a lowercase letter'),
  label: z.string().min(1),
  actions: z.array(action).min(1),
  scoped: z.boolean().optional(),
  /** Fields whose changes go in each record's history, such as amount. */
  trackedFields: z.array(z.string().regex(FIELD_NAME, 'must be a field name')).optional(),
  /** Fields hidden from anyone not given read or edit access to them through fieldAccess, such as amount. */
  protectedFields: z.array(z.string().regex(FIELD_NAME, 'must be a field name')).optional(),
  /** Who sees a record nobody has shared: only those whose scope reaches it, everyone who can read, or everyone who can edit. */
  sharingModel: z.enum(SHARING_MODELS).optional(),
  /** Set on objects an admin defined in the app. Their records are in custom_records, and their fields are below. */
  custom: z.boolean().optional(),
  fields: z.array(z.looseObject({ key: z.string(), label: z.string(), type: z.string() })).optional(),
  /** In Master: this resource's update permission lets someone change access in the named module. */
  managesAccessOf: z.string().optional(),
});

const routeSchema = z.object({
  method,
  path: z.string().startsWith('/'),
  access: z.enum(['public', 'signed', 'private']),
  permission: z.string().optional(),
  anyPermission: z.array(z.string()).min(1).optional(),
  planned: z.boolean().optional(),
});

export const grantSchema = z.object({
  actions: z.array(action).min(1),
  scope: z.enum(SCOPES).optional(),
  /** Access to the resource's protected fields. A protected field not listed here stays hidden. */
  fieldAccess: z.record(z.string(), z.enum(FIELD_ACCESS)).optional(),
});

const grantsRecordSchema = z.record(z.string(), grantSchema);

// A plain union would report only "Invalid input" here, without saying which grant is wrong.
export const grantsSchema = z
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

/** A named bundle of permissions in one module, which people are given on top of their profile. */
const permissionSetSchema = z.object({
  key: z.string().regex(PERMISSION_SET_KEY, 'must be lowercase letters, numbers and hyphens'),
  name: z.string().min(1),
  description: z.string().optional(),
  grants: grantsSchema,
});

const manifestSchema = z.looseObject({
  manifestVersion: z.literal(1),
  module: z.object({
    key: z.string().regex(MODULE_KEY, 'must be lowercase letters, numbers and hyphens, such as "hr", and not "constructor"'),
    name: z.string().min(1),
    version: z.string().regex(SEMVER, 'must look like 1.2.0'),
    description: z.string().optional(),
    repository: z.string().optional(),
    baseUrl: z.string().optional(),
    core: z.boolean().optional(),
  }),
  resources: z.array(resourceSchema),
  routes: z.array(routeSchema).default([]),
  permissionSets: z.array(permissionSetSchema).default([]),
});

export type Manifest = z.infer<typeof manifestSchema>;
export type ManifestResource = z.infer<typeof resourceSchema>;
export type ManifestRoute = z.infer<typeof routeSchema>;
export type ManifestPermissionSet = z.infer<typeof permissionSetSchema>;
export type Grants = ManifestPermissionSet['grants'];

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
    // Only private routes check permissions, so one named anywhere else would look enforced but never be.
    if (route.access !== 'private' && (route.permission !== undefined || route.anyPermission !== undefined)) {
      errors.push({ path: `routes.${index}`, message: `a ${String(route.access)} route can't require a permission` });
    }
  });
  return errors;
}

function readScopedResourceKeys(resources: unknown[]): Set<unknown> {
  return new Set(resources.map(asRecord).filter((resource) => resource.scoped === true).map((resource) => resource.key));
}

/** Checks that grants name only the resources, actions and scopes a module offers. Shared with profiles. */
export function checkGrants(rawGrants: unknown, resources: unknown[], pathPrefix: string): FieldError[] {
  const actionsByResource = readActionsByResource(resources);
  const scopedResourceKeys = readScopedResourceKeys(resources);
  const errors: FieldError[] = [];
  for (const [resourceKey, grant] of Object.entries(asRecord(rawGrants))) {
    const path = `${pathPrefix}.${resourceKey}`;
    const actions = actionsByResource.get(resourceKey);
    if (!actions) {
      errors.push({ path, message: `"${resourceKey}" is not a resource of this module` });
      continue;
    }
    for (const grantedAction of asArray(asRecord(grant).actions)) {
      if (!actions.includes(grantedAction)) errors.push({ path, message: `"${String(grantedAction)}" is not an action of "${resourceKey}"` });
    }
    const { scope } = asRecord(grant);
    if (scope !== undefined && scope !== 'all' && !scopedResourceKeys.has(resourceKey)) {
      errors.push({ path, message: `"${resourceKey}" isn't scoped, so it can't have the scope "${String(scope)}"` });
    }
    const protectedFields = asArray(asRecord(resources.map(asRecord).find((resource) => resource.key === resourceKey)).protectedFields);
    for (const field of Object.keys(asRecord(asRecord(grant).fieldAccess))) {
      if (!protectedFields.includes(field)) errors.push({ path: `${path}.fieldAccess.${field}`, message: `"${field}" is not a protected field of "${resourceKey}"` });
    }
  }
  return errors;
}

/** Checks that span sections, such as a route naming a permission no resource offers. */
function crossChecks(raw: unknown): FieldError[] {
  const manifest = asRecord(raw);
  const resources = asArray(manifest.resources);
  const routes = asArray(manifest.routes);
  const permissionSets = asArray(manifest.permissionSets);

  return [
    ...findDuplicateKeys(resources, 'resources', 'Resource'),
    ...findDuplicateKeys(permissionSets, 'permissionSets', 'Permission set'),
    ...checkRoutes(routes, readActionsByResource(resources)),
    ...permissionSets.flatMap((item, index) => checkGrants(asRecord(item).grants, resources, `permissionSets.${index}.grants`)),
    ...resources.flatMap((item, index) =>
      asRecord(item).grantable !== undefined ? [{ path: `resources.${index}.grantable`, message: 'grantable was removed: people get extra access through permission sets' }] : [],
    ),
    ...(manifest.roles !== undefined ? [{ path: 'roles', message: 'roles were replaced by permissionSets, and people get access through profiles' }] : []),
  ];
}

export function validateManifest(raw: unknown): Validated<Manifest> {
  const parsed = manifestSchema.safeParse(raw);
  const errors = [...(parsed.success ? [] : fieldErrors(parsed.error.issues)), ...crossChecks(raw)];
  if (!parsed.success || errors.length > 0) return { ok: false, errors };
  return { ok: true, value: parsed.data };
}
