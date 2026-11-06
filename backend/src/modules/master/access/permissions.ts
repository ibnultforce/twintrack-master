import type { ModuleDoc } from '../models/module.js';
import type { UserDoc } from '../models/user.js';
import type { ManifestResource, ManifestRole, Scope } from '../moduleRegistry/manifest.js';

export interface ModuleAccess {
  hasAccess: boolean;
  role: string | null;
  roleName: string | null;
  /** Permission to scope, for example { "leave.read": "team" }. */
  permissions: Record<string, Scope>;
  /** The special privileges that count, which leaves out any the module no longer allows. */
  specialPrivileges: string[];
}

type UserAccessFields = Pick<UserDoc, 'superAdmin' | 'assignments' | 'privileges'>;
type ModuleAccessFields = Pick<ModuleDoc, 'key' | 'resources' | 'roles'>;
type PermissionMap = Record<string, Scope>;

const SCOPE_BREADTH: Record<Scope, number> = { own: 0, team: 1, all: 2 };

function grantPermission(permissions: PermissionMap, permission: string, scope: Scope): void {
  const currentScope = permissions[permission];
  if (!currentScope || SCOPE_BREADTH[scope] > SCOPE_BREADTH[currentScope]) permissions[permission] = scope;
}

function grantEverything(permissions: PermissionMap, resources: ManifestResource[]): void {
  for (const resource of resources) {
    for (const action of resource.actions) grantPermission(permissions, `${resource.key}.${action}`, 'all');
  }
}

function applyRole(permissions: PermissionMap, role: ManifestRole, resources: ManifestResource[]): void {
  if (role.grants === '*') {
    grantEverything(permissions, resources);
    return;
  }
  const scopedResources = new Set(resources.filter((resource) => resource.scoped).map((resource) => resource.key));
  for (const [resourceKey, grant] of Object.entries(role.grants)) {
    // A scoped resource with no stated scope gets the narrowest one, so a manifest mistake can't widen access.
    const scope = grant.scope ?? (scopedResources.has(resourceKey) ? 'own' : 'all');
    for (const action of grant.actions) grantPermission(permissions, `${resourceKey}.${action}`, scope);
  }
}

function findPrivilegeScope(privilege: string, resources: ManifestResource[]): Scope | undefined {
  const lastDot = privilege.lastIndexOf('.');
  const resource = resources.find((candidate) => candidate.key === privilege.slice(0, lastDot));
  const action = privilege.slice(lastDot + 1) as ManifestResource['actions'][number];
  if (!resource?.grantable?.includes(action)) return undefined;
  return resource.scoped ? 'team' : 'all';
}

/** Combines a person's fixed role template with their special privileges. The widest scope wins. */
export function resolveModuleAccess(user: UserAccessFields, module: ModuleAccessFields): ModuleAccess {
  const permissions: PermissionMap = {};

  if (user.superAdmin) {
    grantEverything(permissions, module.resources);
    return { hasAccess: true, role: 'super-admin', roleName: 'Super admin', permissions, specialPrivileges: [] };
  }

  // A role the module no longer has, or a module that isn't loaded, grants nothing.
  const role = module.roles.find((candidate) => candidate.key === user.assignments[module.key]);
  if (role) applyRole(permissions, role, module.resources);

  const specialPrivileges: string[] = [];
  for (const privilege of user.privileges[module.key] ?? []) {
    const scope = findPrivilegeScope(privilege, module.resources);
    if (!scope) continue;
    grantPermission(permissions, privilege, scope);
    specialPrivileges.push(privilege);
  }

  return {
    hasAccess: role !== undefined || specialPrivileges.length > 0,
    role: role?.key ?? null,
    roleName: role?.name ?? null,
    permissions,
    specialPrivileges,
  };
}
