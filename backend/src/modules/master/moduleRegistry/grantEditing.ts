import { ApiError } from '../../../lib/errors.js';
import type { Actor } from '../access/caller.js';
import { isWiderScope, listGrantFieldAccess, listGrantPermissions, resolveModuleAccess, type Grantee } from '../access/permissions.js';
import type { AccessProfileDoc } from '../models/accessProfile.js';
import type { ModuleDoc } from '../models/module.js';
import { isWiderFieldAccess, type Grants, type ManifestResource } from './manifest.js';
import { findAllModules } from './moduleRegistry.repository.js';
import { declaredPermissions, listAllowedRules, resolveRouteRule, type AccessRule } from './routeAccess.js';

const EVERYTHING_LABEL = 'Everything in this module';

export const heldPermissions = (grantee: Grantee, module: ModuleDoc) => resolveModuleAccess(grantee, module).permissions;

/**
 * Stops anyone building, changing or giving a profile stronger than their own access in a module. Only a super admin
 * can go beyond it.
 */
export function assertGrantsWithinOwnAccess(actor: Actor, module: ModuleDoc, grants: Grants): void {
  if (actor.user.superAdmin) return;
  // "Everything" would also pick up permissions the module gains later, which nobody can say they hold today.
  if (grants === '*') throw new ApiError(403, 'beyond_own_access', `Only a super admin can give or change a profile that holds everything in ${module.name}.`);

  const held = heldPermissions(actor, module);
  const beyondOwnAccess = Object.entries(listGrantPermissions(grants, module.resources)).filter(([permission, scope]) => {
    const heldScope = held[permission];
    return !heldScope || isWiderScope(scope, heldScope);
  });
  // Field access follows the same rule: nobody can give a level on a field beyond what they have. Hidden gives nothing.
  const heldFields = resolveModuleAccess(actor, module).fieldAccess;
  const fieldsBeyond = Object.entries(listGrantFieldAccess(grants, module.resources))
    .filter(([field, level]) => {
      if (level === 'hidden') return false;
      const heldLevel = heldFields[field];
      return !heldLevel || isWiderFieldAccess(level, heldLevel);
    })
    .map(([field, level]) => `${field} (${level})`);
  const problems = [...beyondOwnAccess.map(([permission]) => permission), ...fieldsBeyond];
  if (problems.length > 0) {
    throw new ApiError(403, 'beyond_own_access', `This profile goes beyond your own access in ${module.name}: ${problems.join(', ')}.`);
  }
}

/**
 * Stops anyone giving, taking away or taking over a profile wider than their own access in any module. A super admin
 * may. A module that isn't loaded grants nothing, so its part of the profile can't go beyond anyone's access.
 */
export async function assertProfileWithinOwnAccess(actor: Actor, profile: Pick<AccessProfileDoc, 'grants'>): Promise<void> {
  if (actor.user.superAdmin) return;
  const modules = await findAllModules();
  for (const [moduleKey, grants] of Object.entries(profile.grants)) {
    const module = modules.find((candidate) => candidate.key === moduleKey);
    if (module) assertGrantsWithinOwnAccess(actor, module, grants);
  }
}

/** What relies on each permission, so an action can't be taken away while something still needs it. */
export function listPermissionUsers(module: ModuleDoc, profiles: Pick<AccessProfileDoc, 'name' | 'grants'>[]): Record<string, string[]> {
  const users: Record<string, string[]> = Object.fromEntries(Object.entries(listPermissionApis(module)).map(([permission, apis]) => [permission, [...apis]]));
  const addUser = (grants: Grants, label: string) => {
    if (grants === '*') return;
    for (const permission of Object.keys(listGrantPermissions(grants, module.resources))) (users[permission] ??= []).push(label);
  };
  for (const profile of profiles) {
    const grants = Object.hasOwn(profile.grants, module.key) ? profile.grants[module.key] : undefined;
    if (grants) addUser(grants, `profile ${profile.name}`);
  }
  return users;
}

/** One built API and who may call it: anyone (public), any signed-in person (signed) or a profile permission (private). */
export interface ModuleApiRoute {
  method: string;
  path: string;
  /** The rule in force, after any change a super admin made. */
  access: AccessRule;
  /** The permissions that open it, any one of which is enough. Empty unless private. */
  permissions: string[];
  /** The rule the API was built with, in its code and manifest. */
  declaredAccess: AccessRule;
  declaredPermissions: string[];
  isChanged: boolean;
  /** The rules a super admin may give it. A single one means it can't be changed. */
  allowedAccess: AccessRule[];
}

type RoutedModule = Pick<ModuleDoc, 'routes' | 'baseUrl' | 'routeAccess'>;

const fullPathOf = (module: Pick<ModuleDoc, 'baseUrl'>, path: string) => `${module.baseUrl && module.baseUrl !== '/' ? module.baseUrl : ''}${path}`;

/** Every built API of a module with the access rule in force, with the module's base path in front. */
export function listModuleRoutes(module: RoutedModule): ModuleApiRoute[] {
  return module.routes
    .filter((route) => !route.planned)
    .map((route) => {
      const path = fullPathOf(module, route.path);
      const rule = resolveRouteRule(route, path, module.routeAccess);
      return {
        method: route.method,
        path,
        access: rule.access,
        permissions: rule.permissions,
        declaredAccess: route.access,
        declaredPermissions: declaredPermissions(route),
        isChanged: rule.isChanged,
        allowedAccess: listAllowedRules(route.access),
      };
    });
}

/** Each permission and the built APIs it opens now, as "METHOD /path". */
export function listPermissionApis(module: RoutedModule): Record<string, string[]> {
  const apis: Record<string, string[]> = {};
  for (const route of listModuleRoutes(module)) {
    for (const permission of route.permissions) (apis[permission] ??= []).push(`${route.method} ${route.path}`);
  }
  return apis;
}

/** Grants as short labels, such as "salary.read (team)". */
export function describeGrants(grants: Grants, resources: ManifestResource[]): string[] {
  if (grants === '*') return [EVERYTHING_LABEL];
  return Object.entries(listGrantPermissions(grants, resources)).map(([permission, scope]) => (scope === 'all' ? permission : `${permission} (${scope})`));
}
