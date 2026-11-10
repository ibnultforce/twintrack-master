import { ApiError } from '../../../lib/errors.js';
import type { Actor } from '../access/caller.js';
import { isWiderScope, listGrantFieldAccess, listGrantPermissions, resolveModuleAccess, type Grantee } from '../access/permissions.js';
import type { AccessProfileDoc } from '../models/accessProfile.js';
import type { ModuleDoc } from '../models/module.js';
import type { Grants, ManifestResource } from './manifest.js';

const EVERYTHING_LABEL = 'Everything in this module';

/** Each module has its own permission set permissions, which work in that module only. */
export type PermissionSetAction = 'read' | 'create' | 'update' | 'delete';
const PERMISSION_SET_ACTIONS: PermissionSetAction[] = ['read', 'create', 'update', 'delete'];
/** These routes check the permission set permissions in their services, so no manifest route names them. */
const PERMISSION_SET_ACTION_APIS: Record<PermissionSetAction, string> = {
  read: 'GET /permission-sets',
  create: 'POST /permission-sets/:module',
  update: 'PATCH /permission-sets/:module/:key',
  delete: 'DELETE /permission-sets/:module/:key',
};

export const heldPermissions = (grantee: Grantee, module: ModuleDoc) => resolveModuleAccess(grantee, module).permissions;

export const canDoToPermissionSetsIn = (grantee: Grantee, module: ModuleDoc, action: PermissionSetAction) =>
  grantee.user.superAdmin || Boolean(heldPermissions(grantee, module)[`permissionSet.${action}`]);

export const canReachPermissionSetsIn = (grantee: Grantee, module: ModuleDoc) =>
  PERMISSION_SET_ACTIONS.some((action) => canDoToPermissionSetsIn(grantee, module, action));

export function assertMayDoToPermissionSetsIn(actor: Actor, module: ModuleDoc, action: PermissionSetAction): void {
  if (!canDoToPermissionSetsIn(actor, module, action)) throw new ApiError(403, 'forbidden', 'You do not have permission to do this.');
}

/** Stops anyone building or changing a permission set or profile stronger than their own access. Only a super admin can go beyond it. */
export function assertGrantsWithinOwnAccess(actor: Actor, module: ModuleDoc, grants: Grants, label: 'permission set' | 'profile'): void {
  if (actor.user.superAdmin) return;
  // "Everything" would also pick up permissions the module gains later, which nobody can say they hold today.
  if (grants === '*') throw new ApiError(403, 'beyond_own_access', `Only a super admin can make a ${label} that holds everything in ${module.name}.`);

  const held = heldPermissions(actor, module);
  const beyondOwnAccess = Object.entries(listGrantPermissions(grants, module.resources)).filter(([permission, scope]) => {
    const heldScope = held[permission];
    return !heldScope || isWiderScope(scope, heldScope);
  });
  // Field access follows the same rule: nobody can give read or edit on a protected field beyond what they have.
  const heldFields = resolveModuleAccess(actor, module).fieldAccess;
  const fieldsBeyond = Object.entries(listGrantFieldAccess(grants, module.resources))
    .filter(([field, level]) => !heldFields[field] || (level === 'edit' && heldFields[field] !== 'edit'))
    .map(([field, level]) => `${field} (${level})`);
  const problems = [...beyondOwnAccess.map(([permission]) => permission), ...fieldsBeyond];
  if (problems.length > 0) {
    throw new ApiError(403, 'beyond_own_access', `This ${label} goes beyond your own access in ${module.name}: ${problems.join(', ')}.`);
  }
}

/** What relies on each permission, so an action can't be taken away while something still needs it. */
export function listPermissionUsers(module: ModuleDoc, profiles: Pick<AccessProfileDoc, 'name' | 'grants'>[]): Record<string, string[]> {
  const users: Record<string, string[]> = Object.fromEntries(Object.entries(listPermissionApis(module)).map(([permission, apis]) => [permission, [...apis]]));
  const addUser = (grants: Grants, label: string) => {
    if (grants === '*') return;
    for (const permission of Object.keys(listGrantPermissions(grants, module.resources))) (users[permission] ??= []).push(label);
  };
  for (const permissionSet of module.permissionSets) addUser(permissionSet.grants, `permission set ${permissionSet.name}`);
  for (const profile of profiles) {
    const grants = Object.hasOwn(profile.grants, module.key) ? profile.grants[module.key] : undefined;
    if (grants) addUser(grants, `profile ${profile.name}`);
  }
  return users;
}

/** Each permission and the built APIs it opens, as "METHOD /path". */
export function listPermissionApis(module: Pick<ModuleDoc, 'routes' | 'baseUrl'>): Record<string, string[]> {
  const prefix = module.baseUrl && module.baseUrl !== '/' ? module.baseUrl : '';
  const apis: Record<string, string[]> = Object.fromEntries(
    PERMISSION_SET_ACTIONS.map((action) => [`permissionSet.${action}`, [PERMISSION_SET_ACTION_APIS[action]]]),
  );
  for (const route of module.routes) {
    if (route.planned) continue;
    for (const permission of route.permission ? [route.permission] : (route.anyPermission ?? [])) {
      (apis[permission] ??= []).push(`${route.method} ${prefix}${route.path}`);
    }
  }
  return apis;
}

/** Grants as short labels, such as "salary.read (team)". */
export function describeGrants(grants: Grants, resources: ManifestResource[]): string[] {
  if (grants === '*') return [EVERYTHING_LABEL];
  return Object.entries(listGrantPermissions(grants, resources)).map(([permission, scope]) => (scope === 'all' ? permission : `${permission} (${scope})`));
}
