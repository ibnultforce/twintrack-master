import type { FieldAccessLevel, FieldAccessMap, Grants, ModuleResource, PermissionMap, ResourceAction, Scope } from './api/types';

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

/** Every field of a resource that field access controls, as the backend counts them. */
export function listAccessFields(resource: ModuleResource): string[] {
  const customFields = (resource.fields ?? []).map((field) => field.key);
  return [...new Set([...(resource.recordFields ?? []), ...(resource.protectedFields ?? []), ...customFields])];
}

/** The widest level a grant's actions make useful on any field: create needs the create action, edit needs update. */
export function widestUsefulFieldLevel(actions: string[]): FieldAccessLevel {
  if (actions.includes('update')) return 'edit';
  if (actions.includes('create')) return 'create';
  if (actions.includes('read')) return 'read';
  return 'hidden';
}

/** The level a grant's actions give a field it doesn't name. A protected field stays hidden. */
export function impliedFieldLevel(resource: ModuleResource, field: string, actions: string[]): FieldAccessLevel {
  return resource.protectedFields?.includes(field) ? 'hidden' : widestUsefulFieldLevel(actions);
}

/** Builds the grants the API expects. A scope is sent only for resources that have one, because others refuse it. */
export function buildGrants(selected: Set<string>, scopes: Record<string, Scope>, resources: ModuleResource[], fieldAccess: FieldAccessMap = {}): Grants {
  const grants: Grants = {};
  for (const resource of resources) {
    const actions = resource.actions.filter((action) => selected.has(permissionKey(resource.key, action)));
    if (actions.length === 0) continue;
    const fields = Object.fromEntries(listAccessFields(resource).flatMap((field) => {
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
