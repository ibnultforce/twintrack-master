import { ApiError } from '../../../lib/errors.js';
import type { AccessProfileDoc } from '../models/accessProfile.js';
import type { UserDoc } from '../models/user.js';
import type { Actor } from './caller.js';
import type { Grantee } from './permissions.js';
import { listPermissionApis } from '../moduleRegistry/grantEditing.js';
import { findAllModules, findModuleByKey } from '../moduleRegistry/moduleRegistry.repository.js';
import { resolveModuleAccess, type ModuleAccess, type PermissionMap } from './permissions.js';

export interface AccessibleModule {
  key: string;
  name: string;
  description?: string;
  /** Where the portal sends people to open this module. Null until MODULE_FRONTEND_URLS has it. */
  frontendUrl: string | null;
  profileName: string | null;
}

export async function listModulesForUser(grantee: Grantee, frontendUrls: Map<string, string>): Promise<AccessibleModule[]> {
  const modules = await findAllModules();
  return modules.flatMap((module) => {
    const access = resolveModuleAccess(grantee, module);
    if (!access.hasAccess) return [];
    return [
      {
        key: module.key,
        name: module.name,
        description: module.description,
        frontendUrl: frontendUrls.get(module.key) ?? null,
        profileName: access.profileName,
      },
    ];
  });
}

/**
 * What this person can do in one module, and the APIs each permission they hold opens, as "METHOD /path", so they can
 * try them.
 */
export async function getModuleAccessForUser(grantee: Grantee, moduleKey: string): Promise<ModuleAccess & { apis: Record<string, string[]> }> {
  const module = await findModuleByKey(moduleKey);
  if (!module) throw new ApiError(404, 'unknown_module', 'No such module.');
  const access = resolveModuleAccess(grantee, module);
  const apis = Object.fromEntries(Object.entries(listPermissionApis(module)).filter(([permission]) => Boolean(access.permissions[permission])));
  return { ...access, apis };
}

/** What this person can do in one module, for signed routes whose services decide the access. Empty if it isn't loaded. */
export async function findPermissionsIn(grantee: Grantee, moduleKey: string): Promise<PermissionMap> {
  const module = await findModuleByKey(moduleKey);
  return module ? resolveModuleAccess(grantee, module).permissions : {};
}

/**
 * The same actor a private route's permission check builds, for callers that aren't a route, such as MCP tools.
 * Null when the person has no access to the module.
 */
export async function buildActorIn(person: { user: UserDoc; profile: AccessProfileDoc | null }, moduleKey: string): Promise<Actor | null> {
  const module = await findModuleByKey(moduleKey);
  const access = module ? resolveModuleAccess(person, module) : null;
  if (!access?.hasAccess) return null;
  return { ...person, ipAddress: undefined, permissions: access.permissions, fieldAccess: access.fieldAccess };
}
