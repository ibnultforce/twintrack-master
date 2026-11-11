import type { AccessProfileDoc } from '../models/accessProfile.js';
import type { ModuleDoc } from '../models/module.js';
import type { UserDoc } from '../models/user.js';
import { isWiderFieldAccess, listAccessFields, type FieldAccessLevel, type Grant, type Grants, type ManifestResource, type Scope } from '../moduleRegistry/manifest.js';

export interface ModuleAccess {
  hasAccess: boolean;
  profile: string | null;
  profileName: string | null;
  /** Permission to scope, for example { "salary.read": "team" }. */
  permissions: Record<string, Scope>;
  /** Each controlled field, as "resource.field" to its level. A field not listed is hidden. */
  fieldAccess: FieldAccessMap;
}

/** Someone whose access is being worked out: the person, and the profile they hold, if any. */
export interface Grantee {
  user: Pick<UserDoc, 'superAdmin'>;
  profile: Pick<AccessProfileDoc, '_id' | 'name' | 'grants'> | null;
}

type ModuleAccessFields = Pick<ModuleDoc, 'key' | 'resources'> & Partial<Pick<ModuleDoc, 'routes'>>;
export type PermissionMap = Record<string, Scope>;
export type FieldAccessMap = Record<string, FieldAccessLevel>;

/** The widest level wins, as with scopes. */
const grantFieldAccess = (fieldAccess: FieldAccessMap, field: string, level: FieldAccessLevel) => {
  const current = fieldAccess[field];
  if (!current || isWiderFieldAccess(level, current)) fieldAccess[field] = level;
};

const SCOPE_BREADTH: Record<Scope, number> = { own: 0, team: 1, all: 2 };

export const isWiderScope = (candidate: Scope, current: Scope) => SCOPE_BREADTH[candidate] > SCOPE_BREADTH[current];

function grantPermission(permissions: PermissionMap, permission: string, scope: Scope): void {
  const currentScope = permissions[permission];
  if (!currentScope || isWiderScope(scope, currentScope)) permissions[permission] = scope;
}

function grantEverything(permissions: PermissionMap, resources: ManifestResource[], fieldAccess?: FieldAccessMap): void {
  for (const resource of resources) {
    for (const action of resource.actions) grantPermission(permissions, `${resource.key}.${action}`, 'all');
    for (const field of listAccessFields(resource)) if (fieldAccess) grantFieldAccess(fieldAccess, `${resource.key}.${field}`, 'edit');
  }
}

/** Adds what a set of grants allows. Grants naming a resource or action the module no longer has give nothing. */
function applyGrants(permissions: PermissionMap, grants: Grants, resources: ManifestResource[], fieldAccess?: FieldAccessMap): void {
  if (grants === '*') {
    grantEverything(permissions, resources, fieldAccess);
    return;
  }
  for (const [resourceKey, grant] of Object.entries(grants)) {
    const resource = resources.find((candidate) => candidate.key === resourceKey);
    if (!resource) continue;
    // A scoped resource with no stated scope gets the narrowest one, so a mistake can't widen access.
    const scope = resource.scoped ? (grant.scope ?? 'own') : 'all';
    for (const action of grant.actions) {
      if (resource.actions.includes(action)) grantPermission(permissions, `${resourceKey}.${action}`, scope);
    }
    if (fieldAccess) applyFieldGrant(fieldAccess, resource, grant);
  }
}

/** The level a grant's actions give a field it doesn't name. */
function levelFromActions(actions: string[]): FieldAccessLevel | undefined {
  if (actions.includes('update')) return 'edit';
  if (actions.includes('create')) return 'create';
  if (actions.includes('read')) return 'read';
  return undefined;
}

/** A named field gets its stated level. Any other follows the actions, except a protected field, which stays hidden. */
function applyFieldGrant(fieldAccess: FieldAccessMap, resource: ManifestResource, grant: Grant): void {
  const impliedLevel = levelFromActions(grant.actions.filter((action) => resource.actions.includes(action)));
  for (const field of listAccessFields(resource)) {
    const statedLevel = readOwnEntry(grant.fieldAccess ?? {}, field);
    const level = statedLevel ?? (resource.protectedFields?.includes(field) ? undefined : impliedLevel);
    if (level) grantFieldAccess(fieldAccess, `${resource.key}.${field}`, level);
  }
}

/** The field levels a set of grants states outright, for editing them. Fields left to follow the actions aren't listed. */
export function listStatedFieldAccess(grants: Grants, resources: ManifestResource[]): FieldAccessMap {
  if (grants === '*') return {};
  const stated: FieldAccessMap = {};
  for (const [resourceKey, grant] of Object.entries(grants)) {
    const resource = resources.find((candidate) => candidate.key === resourceKey);
    if (!resource) continue;
    const accessFields = listAccessFields(resource);
    for (const [field, level] of Object.entries(grant.fieldAccess ?? {})) {
      if (accessFields.includes(field)) stated[`${resourceKey}.${field}`] = level;
    }
  }
  return stated;
}

/** What one set of grants gives on every controlled field in a module, counting levels that follow the actions. */
export function listGrantFieldAccess(grants: Grants, resources: ManifestResource[]): FieldAccessMap {
  const fieldAccess: FieldAccessMap = {};
  applyGrants({}, grants, resources, fieldAccess);
  return fieldAccess;
}

/** What one set of grants allows in a module, such as a profile's part for that module. */
export function listGrantPermissions(grants: Grants, resources: ManifestResource[]): PermissionMap {
  const permissions: PermissionMap = {};
  applyGrants(permissions, grants, resources);
  return permissions;
}

/** Reads an access map, which is a plain object, without finding anything it inherits from JavaScript. */
export const readOwnEntry = <Value>(map: Record<string, Value>, key: string): Value | undefined =>
  Object.hasOwn(map, key) ? map[key] : undefined;

/** What a person's profile allows in one module. A super admin holds everything. */
export function resolveModuleAccess({ user, profile }: Grantee, module: ModuleAccessFields): ModuleAccess {
  const permissions: PermissionMap = {};
  const fieldAccess: FieldAccessMap = {};

  if (user.superAdmin) {
    grantEverything(permissions, module.resources, fieldAccess);
    // A super admin may remove an action an API still needs, which leaves that API to super admins rather than nobody.
    for (const route of module.routes ?? []) {
      for (const permission of route.permission ? [route.permission] : (route.anyPermission ?? [])) grantPermission(permissions, permission, 'all');
    }
    return { hasAccess: true, profile: 'super-admin', profileName: 'Super admin', permissions, fieldAccess };
  }

  const profileGrants = profile ? readOwnEntry(profile.grants, module.key) : undefined;
  // A module that isn't loaded, or a resource or action it no longer has, grants nothing.
  if (profileGrants) applyGrants(permissions, profileGrants, module.resources, fieldAccess);

  return {
    hasAccess: Object.keys(permissions).length > 0,
    profile: profile?._id ?? null,
    profileName: profile?.name ?? null,
    permissions,
    fieldAccess,
  };
}
