import type { AccessProfileDoc } from '../models/accessProfile.js';
import type { ModuleDoc } from '../models/module.js';
import type { UserDoc } from '../models/user.js';
import type { FieldAccessLevel, Grants, ManifestResource, Scope } from '../moduleRegistry/manifest.js';

export interface ModuleAccess {
  hasAccess: boolean;
  profile: string | null;
  profileName: string | null;
  /** Permission to scope, for example { "salary.read": "team" }. */
  permissions: Record<string, Scope>;
  /** The keys of the permission sets that count here, leaving out any the module no longer has. */
  permissionSets: string[];
  /** Access to protected fields, as "resource.field" to read or edit. A protected field not listed is hidden. */
  fieldAccess: FieldAccessMap;
}

/** Someone whose access is being worked out: the person, and the profile they hold, if any. */
export interface Grantee {
  user: Pick<UserDoc, 'superAdmin' | 'permissionSets'>;
  profile: Pick<AccessProfileDoc, '_id' | 'name' | 'grants'> | null;
}

type ModuleAccessFields = Pick<ModuleDoc, 'key' | 'resources' | 'permissionSets'> & Partial<Pick<ModuleDoc, 'routes'>>;
export type PermissionMap = Record<string, Scope>;
export type FieldAccessMap = Record<string, FieldAccessLevel>;

/** Edit includes read, so it's the wider of the two. */
const grantFieldAccess = (fieldAccess: FieldAccessMap, field: string, level: FieldAccessLevel) => {
  if (fieldAccess[field] !== 'edit') fieldAccess[field] = level;
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
    for (const field of resource.protectedFields ?? []) if (fieldAccess) grantFieldAccess(fieldAccess, `${resource.key}.${field}`, 'edit');
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
    for (const [field, level] of Object.entries(grant.fieldAccess ?? {})) {
      if (fieldAccess && resource.protectedFields?.includes(field)) grantFieldAccess(fieldAccess, `${resourceKey}.${field}`, level);
    }
  }
}

/** What one set of grants gives on protected fields in a module. */
export function listGrantFieldAccess(grants: Grants, resources: ManifestResource[]): FieldAccessMap {
  const fieldAccess: FieldAccessMap = {};
  applyGrants({}, grants, resources, fieldAccess);
  return fieldAccess;
}

/** What one set of grants allows in a module, such as a permission set or a profile's part for that module. */
export function listGrantPermissions(grants: Grants, resources: ManifestResource[]): PermissionMap {
  const permissions: PermissionMap = {};
  applyGrants(permissions, grants, resources);
  return permissions;
}

/** Reads an access map, which is a plain object, without finding anything it inherits from JavaScript. */
export const readOwnEntry = <Value>(map: Record<string, Value>, key: string): Value | undefined =>
  Object.hasOwn(map, key) ? map[key] : undefined;

/** Combines a person's profile with the permission sets they hold in one module. The widest scope wins. */
export function resolveModuleAccess({ user, profile }: Grantee, module: ModuleAccessFields): ModuleAccess {
  const permissions: PermissionMap = {};
  const fieldAccess: FieldAccessMap = {};

  if (user.superAdmin) {
    grantEverything(permissions, module.resources, fieldAccess);
    // A super admin may remove an action an API still needs, which leaves that API to super admins rather than nobody.
    for (const route of module.routes ?? []) {
      for (const permission of route.permission ? [route.permission] : (route.anyPermission ?? [])) grantPermission(permissions, permission, 'all');
    }
    return { hasAccess: true, profile: 'super-admin', profileName: 'Super admin', permissions, permissionSets: [], fieldAccess };
  }

  const profileGrants = profile ? readOwnEntry(profile.grants, module.key) : undefined;
  if (profileGrants) applyGrants(permissions, profileGrants, module.resources, fieldAccess);

  // A set the module no longer has, or a module that isn't loaded, grants nothing.
  const permissionSets: string[] = [];
  for (const setKey of readOwnEntry(user.permissionSets ?? {}, module.key) ?? []) {
    const permissionSet = module.permissionSets.find((candidate) => candidate.key === setKey);
    if (!permissionSet) continue;
    applyGrants(permissions, permissionSet.grants, module.resources, fieldAccess);
    permissionSets.push(setKey);
  }

  return {
    hasAccess: Object.keys(permissions).length > 0,
    profile: profile?._id ?? null,
    profileName: profile?.name ?? null,
    permissions,
    permissionSets,
    fieldAccess,
  };
}
