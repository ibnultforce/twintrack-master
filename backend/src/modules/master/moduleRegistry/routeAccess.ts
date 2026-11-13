import type { ManifestRoute } from './manifest.js';

export type AccessRule = ManifestRoute['access'];

/**
 * A super admin's change to one API's access rule, saved on the module and read on every request to that API. The
 * path includes the module's base path, as the API is called, such as "/hr/salaries".
 */
export interface RouteAccessChange {
  method: string;
  path: string;
  access: AccessRule;
  /** The permission that opens it when private. */
  permission?: string;
  changedBy: string;
  changedAt: Date;
}

/** What decides who may call an API right now: its built rule, or a super admin's change to it. */
export interface EffectiveRouteRule {
  access: AccessRule;
  /** Any one of these opens a private API. Empty for public and signed. */
  permissions: string[];
  isChanged: boolean;
}

type RouteDeclaration = Pick<ManifestRoute, 'method' | 'path' | 'access' | 'permission' | 'anyPermission'>;

export const declaredPermissions = (route: Pick<ManifestRoute, 'permission' | 'anyPermission'>) =>
  route.permission ? [route.permission] : (route.anyPermission ?? []);

/**
 * Which rules an API can be given. A built-public API (sign-in, MCP, file links) works before anyone has a session, so
 * requiring one would lock people out: it stays as built. Every other API's code works with the person calling, so it
 * can't be made public, but can move between signed and private.
 */
export function listAllowedRules(declaredAccess: AccessRule): AccessRule[] {
  return declaredAccess === 'public' ? ['public'] : ['signed', 'private'];
}

export function findRouteAccessChange(changes: RouteAccessChange[] | undefined, method: string, path: string): RouteAccessChange | undefined {
  return changes?.find((change) => change.method === method && change.path === path);
}

/** The rule in force for an API, given its full path and the module's saved changes. */
export function resolveRouteRule(route: RouteDeclaration, fullPath: string, changes: RouteAccessChange[] | undefined): EffectiveRouteRule {
  const change = findRouteAccessChange(changes, route.method, fullPath);
  // A change the built code can no longer take, such as one saved before the API became public, is ignored.
  if (!change || !listAllowedRules(route.access).includes(change.access)) {
    return { access: route.access, permissions: declaredPermissions(route), isChanged: false };
  }
  const permissions = change.access === 'private' ? (change.permission ? [change.permission] : declaredPermissions(route)) : [];
  return { access: change.access, permissions, isChanged: true };
}
