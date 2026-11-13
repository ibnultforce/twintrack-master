import { ApiError } from '../../../lib/errors.js';
import { actorFields, type Actor } from '../access/caller.js';
import { recordAudit } from '../audit/audit.repository.js';
import { listModuleRoutes, type ModuleApiRoute } from './grantEditing.js';
import type { AccessRule, RouteAccessChange } from './routeAccess.js';
import { saveRouteAccessChanges } from './moduleRegistry.repository.js';
import { editModuleRules } from './permissionRules.service.js';

export interface RouteAccessRequest {
  method: string;
  /** As the API is called, with the module's base path, such as "/hr/salaries". */
  path: string;
  access: AccessRule;
  permission?: string;
}

const sameList = (first: string[], second: string[]) => first.length === second.length && first.every((item, index) => item === second[index]);

/** The permission a private API will need: the one asked for, or the one it was built with. */
function choosePermission(route: ModuleApiRoute, requested: string | undefined, resourcePermissions: Set<string>): string[] {
  if (requested) {
    if (!resourcePermissions.has(requested)) throw new ApiError(422, 'validation_failed', `"${requested}" is not a permission in this module.`, [{ path: 'permission', message: 'is not a permission in this module' }]);
    return [requested];
  }
  if (route.declaredPermissions.length === 0) {
    throw new ApiError(422, 'validation_failed', 'A private API needs a permission.', [{ path: 'permission', message: 'is required to make this API private' }]);
  }
  return route.declaredPermissions;
}

/**
 * Changes who may call one API, from now on. Only a super admin may, since it changes access for everyone. Going back
 * to the rule the API was built with removes the change.
 */
export async function changeRouteAccess(actor: Actor, moduleKey: string, request: RouteAccessRequest): Promise<ModuleApiRoute> {
  if (!actor.user.superAdmin) throw new ApiError(403, 'super_admin_only', 'Only a super admin can change who may call an API.');

  return editModuleRules(moduleKey, async (module, session) => {
    const route = listModuleRoutes(module).find((candidate) => candidate.method === request.method && candidate.path === request.path);
    if (!route) throw new ApiError(404, 'unknown_route', `${request.method} ${request.path} is not an API in ${module.name}.`);
    if (!route.allowedAccess.includes(request.access)) {
      const reason = route.declaredAccess === 'public'
        ? 'It works before anyone signs in, so it stays public.'
        : 'Its code needs to know who is calling, so it can be signed in or private.';
      throw new ApiError(422, 'access_not_allowed', `${route.method} ${route.path} can't be made ${request.access}. ${reason}`);
    }

    const resourcePermissions = new Set(module.resources.flatMap((resource) => resource.actions.map((action) => `${resource.key}.${action}`)));
    const permissions = request.access === 'private' ? choosePermission(route, request.permission, resourcePermissions) : [];
    const isAsBuilt = request.access === route.declaredAccess && sameList(permissions, route.declaredPermissions);

    const others = (module.routeAccess ?? []).filter((change) => !(change.method === route.method && change.path === route.path));
    const change: RouteAccessChange = {
      method: route.method,
      path: route.path,
      access: request.access,
      ...(request.access === 'private' && { permission: permissions[0] }),
      changedBy: actor.user._id,
      changedAt: new Date(),
    };
    const routeAccess = isAsBuilt ? others : [...others, change];
    await saveRouteAccessChanges(module.key, routeAccess, session);
    await recordAudit(
      {
        action: 'module.routeAccessChanged',
        ...actorFields(actor),
        targetType: 'route',
        targetId: `${route.method} ${route.path}`,
        targetName: `${route.method} ${route.path}`,
        module: module.key,
        before: { access: route.access, permissions: route.permissions },
        after: { access: request.access, permissions },
      },
      session,
    );
    return listModuleRoutes({ ...module, routeAccess }).find((candidate) => candidate.method === route.method && candidate.path === route.path)!;
  });
}
