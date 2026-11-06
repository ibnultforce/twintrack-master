import { ApiError } from '../../../lib/errors.js';
import type { UserDoc } from '../models/user.js';
import { findAllModules, findModuleByKey } from '../moduleRegistry/moduleRegistry.repository.js';
import { resolveModuleAccess, type ModuleAccess } from './permissions.js';

export interface AccessibleModule {
  key: string;
  name: string;
  description?: string;
  /** Where the portal sends people to open this module. Null until MODULE_FRONTEND_URLS has it. */
  frontendUrl: string | null;
  roleName: string | null;
}

export async function listModulesForUser(user: UserDoc, frontendUrls: Map<string, string>): Promise<AccessibleModule[]> {
  const modules = await findAllModules();
  return modules.flatMap((module) => {
    const access = resolveModuleAccess(user, module);
    if (!access.hasAccess) return [];
    return [
      {
        key: module.key,
        name: module.name,
        description: module.description,
        frontendUrl: frontendUrls.get(module.key) ?? null,
        roleName: access.roleName,
      },
    ];
  });
}

export async function getModuleAccessForUser(user: UserDoc, moduleKey: string): Promise<ModuleAccess> {
  const module = await findModuleByKey(moduleKey);
  if (!module) throw new ApiError(404, 'unknown_module', 'No such module.');
  return resolveModuleAccess(user, module);
}
