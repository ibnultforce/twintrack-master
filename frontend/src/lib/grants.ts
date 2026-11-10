import type { FieldAccessMap, Grants, ModuleResource, PermissionMap, ResourceAction, Scope } from './api/types';

export const ALL_ACTIONS: ResourceAction[] = ['read', 'create', 'update', 'delete', 'approve', 'share'];

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
export function buildGrants(selected: Set<string>, scopes: Record<string, Scope>, resources: ModuleResource[], fieldAccess: FieldAccessMap = {}): Grants {
  const grants: Grants = {};
  for (const resource of resources) {
    const actions = resource.actions.filter((action) => selected.has(permissionKey(resource.key, action)));
    if (actions.length === 0) continue;
    const fields = Object.fromEntries((resource.protectedFields ?? []).flatMap((field) => {
      const level = fieldAccess[permissionKey(resource.key, field)];
      return level ? [[field, level]] : [];
    }));
    grants[resource.key] = {
      actions,
      ...(resource.scoped && { scope: scopes[resource.key] ?? 'own' }),
      ...(Object.keys(fields).length > 0 && { fieldAccess: fields }),
    };
  }
  return grants;
}

/** Makes a permission set's key from its name, such as "Payroll Clerk" to "payroll-clerk". A name with no Latin letters gets a generated key. */
export function setKeyFromName(name: string): string {
  const key = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+/, '').replace(/-+$/, '');
  return key || `set-${Date.now().toString(36)}`;
}

/** Adds two permission maps, keeping the wider scope where they overlap. */
export function combinePermissions(...maps: PermissionMap[]): PermissionMap {
  const combined: PermissionMap = {};
  for (const map of maps) {
    for (const [permission, scope] of Object.entries(map)) {
      const current = combined[permission];
      if (!current || isWiderScope(scope, current)) combined[permission] = scope;
    }
  }
  return combined;
}
