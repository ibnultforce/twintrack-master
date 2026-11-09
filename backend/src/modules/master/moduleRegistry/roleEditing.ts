import { ApiError } from '../../../lib/errors.js';
import type { Actor } from '../access/caller.js';
import { isWiderScope, listRolePermissions, resolveModuleAccess } from '../access/permissions.js';
import type { ModuleDoc } from '../models/module.js';
import type { UserDoc } from '../models/user.js';
import type { ManifestRole } from './manifest.js';

/** A module's own role.update lets someone create and edit roles in that module only. */
const ROLE_EDITING_PERMISSION = 'role.update';
/** These routes check role.update in their services, so no manifest route names it. */
const ROLE_EDITING_APIS = ['POST /roles/:module', 'PATCH /roles/:module/:key', 'DELETE /roles/:module/:key'];

export const heldPermissions = (user: UserDoc, module: ModuleDoc) => resolveModuleAccess(user, module).permissions;

export const canEditRolesIn = (user: UserDoc, module: ModuleDoc) => user.superAdmin || Boolean(heldPermissions(user, module)[ROLE_EDITING_PERMISSION]);

export function assertMayEditRolesIn(actor: Actor, module: ModuleDoc): void {
  if (!canEditRolesIn(actor.user, module)) throw new ApiError(403, 'forbidden', 'You do not have permission to do this.');
}

/** Stops anyone building or changing a role stronger than their own access. Only a super admin can go beyond it. */
export function assertRoleWithinOwnAccess(actor: Actor, module: ModuleDoc, role: ManifestRole): void {
  if (actor.user.superAdmin) return;
  // "Everything" would also pick up permissions the module gains later, which nobody can say they hold today.
  if (role.grants === '*') throw new ApiError(403, 'beyond_own_access', 'Only a super admin can make a role that holds everything.');

  const held = heldPermissions(actor.user, module);
  const beyondOwnAccess = Object.entries(listRolePermissions(role, module.resources)).filter(([permission, scope]) => {
    const heldScope = held[permission];
    return !heldScope || isWiderScope(scope, heldScope);
  });
  if (beyondOwnAccess.length > 0) {
    throw new ApiError(403, 'beyond_own_access', `This role goes beyond your own access: ${beyondOwnAccess.map(([permission]) => permission).join(', ')}.`);
  }
}

/** Each permission and the built APIs it opens, as "METHOD /path". */
export function listPermissionApis(module: Pick<ModuleDoc, 'routes' | 'baseUrl'>): Record<string, string[]> {
  const prefix = module.baseUrl && module.baseUrl !== '/' ? module.baseUrl : '';
  const apis: Record<string, string[]> = { [ROLE_EDITING_PERMISSION]: [...ROLE_EDITING_APIS] };
  for (const route of module.routes) {
    if (route.planned) continue;
    for (const permission of route.permission ? [route.permission] : (route.anyPermission ?? [])) {
      (apis[permission] ??= []).push(`${route.method} ${prefix}${route.path}`);
    }
  }
  return apis;
}
