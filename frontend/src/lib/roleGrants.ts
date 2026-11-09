import type { ModuleResource, PermissionMap, ResourceAction, RoleGrants, Scope } from './api/types';

export const ALL_ACTIONS: ResourceAction[] = ['read', 'create', 'update', 'delete', 'approve'];

const SCOPE_BREADTH: Record<Scope, number> = { own: 0, team: 1, all: 2 };

export const isWiderScope = (candidate: Scope, current: Scope) => SCOPE_BREADTH[candidate] > SCOPE_BREADTH[current];

export const permissionKey = (resourceKey: string, action: string) => `${resourceKey}.${action}`;

export function readResourceScopes(permissions: PermissionMap, resources: ModuleResource[]): Record<string, Scope> {
  const scopes: Record<string, Scope> = {};
  for (const resource of resources) {
    const heldAction = resource.actions.find((action) => permissions[permissionKey(resource.key, action)]);
    scopes[resource.key] = heldAction ? permissions[permissionKey(resource.key, heldAction)]! : 'own';
  }
  return scopes;
}

/** Builds the grants the API expects. A scope is sent only for resources that have one, because others refuse it. */
export function buildRoleGrants(selected: Set<string>, scopes: Record<string, Scope>, resources: ModuleResource[]): RoleGrants {
  const grants: RoleGrants = {};
  for (const resource of resources) {
    const actions = resource.actions.filter((action) => selected.has(permissionKey(resource.key, action)));
    if (actions.length === 0) continue;
    grants[resource.key] = resource.scoped ? { actions, scope: scopes[resource.key] ?? 'own' } : { actions };
  }
  return grants;
}

/** Makes a role's key from its name, such as "Payroll Clerk" to "payroll-clerk". A name with no Latin letters gets a generated key. */
export function roleKeyFromName(name: string): string {
  const key = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+/, '').replace(/-+$/, '');
  return key || `role-${Date.now().toString(36)}`;
}
