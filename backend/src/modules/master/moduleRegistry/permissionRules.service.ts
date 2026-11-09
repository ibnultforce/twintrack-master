import type { ClientSession } from 'mongoose';
import { runInTransaction } from '../../../db.js';
import { ApiError } from '../../../lib/errors.js';
import { actorFields, type Actor } from '../access/caller.js';
import { listRolePermissions } from '../access/permissions.js';
import { recordAudit } from '../audit/audit.repository.js';
import type { ModuleDoc } from '../models/module.js';
import type { UserDoc } from '../models/user.js';
import { countUsersWithRole } from '../users/users.repository.js';
import { validateManifest, type ManifestResource, type ManifestRole } from './manifest.js';
import { findAllModules, findModuleByKey, updateModulePermissionRules } from './moduleRegistry.repository.js';
import { describeRoleGrants } from './moduleRegistry.service.js';
import { assertMayEditRolesIn, assertRoleWithinOwnAccess, canEditRolesIn, heldPermissions, listPermissionApis } from './roleEditing.js';

export type RoleTemplateChanges = Partial<Pick<ManifestRole, 'name' | 'description'>> & { grants?: unknown };
export type NewRole = Pick<ManifestRole, 'key' | 'name' | 'description'> & { grants: unknown };
export type ResourceDetails = { label: string; actions: string[]; scoped?: boolean };

interface RuleChange {
  action: string;
  targetType: string;
  targetId: string;
  targetName: string;
  before?: unknown;
  after?: unknown;
}

async function requireModule(moduleKey: string, session: ClientSession): Promise<ModuleDoc> {
  const module = await findModuleByKey(moduleKey, session);
  if (!module) throw new ApiError(404, 'unknown_module', 'No such module.');
  return module;
}

function requireRole(module: ModuleDoc, roleKey: string): ManifestRole {
  const role = module.roles.find((candidate) => candidate.key === roleKey);
  if (!role) throw new ApiError(404, 'unknown_role', `"${roleKey}" is not a role in ${module.name}.`);
  return role;
}

function requireResource(module: ModuleDoc, resourceKey: string): ManifestResource {
  const resource = module.resources.find((candidate) => candidate.key === resourceKey);
  if (!resource) throw new ApiError(404, 'unknown_resource', `"${resourceKey}" is not a resource in ${module.name}.`);
  return resource;
}

export async function canEditRolesSomewhere(user: UserDoc): Promise<boolean> {
  return (await findAllModules()).some((module) => canEditRolesIn(user, module));
}

const allPermissionsAtFullReach = (module: ModuleDoc) =>
  Object.fromEntries(module.resources.flatMap((resource) => resource.actions.map((action) => [`${resource.key}.${action}`, 'all'])));

/** The modules this person can edit roles in, with what they're allowed to put in a role. */
export async function listManageableRoles(actor: Actor) {
  const modules = (await findAllModules()).filter((module) => canEditRolesIn(actor.user, module));
  return modules.map((module) => ({
    key: module.key,
    name: module.name,
    resources: module.resources,
    apis: listPermissionApis(module),
    assignable: actor.user.superAdmin ? allPermissionsAtFullReach(module) : heldPermissions(actor.user, module),
    roles: module.roles.map((role) => ({ ...toRoleView(module, role), permissions: listRolePermissions(role, module.resources) })),
  }));
}

/**
 * Runs an edit that reads a module's rules and writes them back. Each edit rewrites a whole list, so the read has to be
 * inside the transaction: when two edits collide, the database retries one of them against the other's result.
 */
function editModuleRules<Result>(moduleKey: string, edit: (module: ModuleDoc, session: ClientSession) => Promise<Result>): Promise<Result> {
  return runInTransaction(async (session) => edit(await requireModule(moduleKey, session), session));
}

/** Validates the module with an edit applied, using the same checks as an imported manifest, then saves and records it. */
async function saveRules(
  actor: Actor,
  module: ModuleDoc,
  rules: Partial<Pick<ModuleDoc, 'roles' | 'resources'>>,
  change: RuleChange,
  session: ClientSession,
  roleToKeepWithinAccess?: ManifestRole,
): Promise<void> {
  const validated = validateManifest({
    manifestVersion: 1,
    module: { key: module.key, name: module.name, version: module.version },
    routes: module.routes,
    roles: rules.roles ?? module.roles,
    resources: rules.resources ?? module.resources,
  });
  if (!validated.ok) throw new ApiError(422, 'validation_failed', 'That would make the module invalid.', validated.errors);
  // After validation, because reading a role's permissions relies on its grants being well formed.
  if (roleToKeepWithinAccess) assertRoleWithinOwnAccess(actor, module, roleToKeepWithinAccess);

  await updateModulePermissionRules(module.key, rules, session);
  await recordAudit({ ...change, ...actorFields(actor), module: module.key }, session);
}

const toRoleView = (module: ModuleDoc, role: ManifestRole) => ({
  module: module.key,
  moduleName: module.name,
  key: role.key,
  name: role.name,
  description: role.description ?? '',
  grants: describeRoleGrants(role, module.resources),
});

/** Adds a role to a module. People can be given it straight away. */
export function addRole(actor: Actor, moduleKey: string, newRole: NewRole) {
  return editModuleRules(moduleKey, async (module, session) => {
    assertMayEditRolesIn(actor, module);
    const role = newRole as ManifestRole;
    await saveRules(actor, module, { roles: [...module.roles, role] }, {
      action: 'role.created',
      targetType: 'role',
      targetId: `${moduleKey}.${role.key}`,
      targetName: role.name,
      after: { name: role.name, grants: role.grants },
    }, session, role);
    return toRoleView(module, role);
  });
}

/** Changes what one role template allows. It applies to everyone with that role on their next request. */
export function updateRoleTemplate(actor: Actor, moduleKey: string, roleKey: string, changes: RoleTemplateChanges) {
  return editModuleRules(moduleKey, async (module, session) => {
    assertMayEditRolesIn(actor, module);
    const role = requireRole(module, roleKey);
    assertRoleWithinOwnAccess(actor, module, role);
    const editedRole = { ...role, ...changes } as ManifestRole;
    const roles = module.roles.map((candidate) => (candidate.key === roleKey ? editedRole : candidate));
    await saveRules(actor, module, { roles }, {
      action: 'role.updated',
      targetType: 'role',
      targetId: `${moduleKey}.${roleKey}`,
      targetName: editedRole.name,
      before: { name: role.name, description: role.description, grants: role.grants },
      after: { name: editedRole.name, description: editedRole.description, grants: editedRole.grants },
    }, session, editedRole);
    return toRoleView(module, editedRole);
  });
}

/** Removes a role nobody holds. Refusing a role in use means nobody loses access without someone choosing their new role. */
export function removeRole(actor: Actor, moduleKey: string, roleKey: string) {
  return editModuleRules(moduleKey, async (module, session) => {
    assertMayEditRolesIn(actor, module);
    const role = requireRole(module, roleKey);
    assertRoleWithinOwnAccess(actor, module, role);
    const holders = await countUsersWithRole(moduleKey, roleKey, session);
    if (holders > 0) throw new ApiError(409, 'role_in_use', `${holders} people have this role. Give them another role first.`);

    await saveRules(actor, module, { roles: module.roles.filter((candidate) => candidate.key !== roleKey) }, {
      action: 'role.removed',
      targetType: 'role',
      targetId: `${moduleKey}.${roleKey}`,
      targetName: role.name,
      before: { name: role.name, grants: role.grants },
    }, session);
    return { removed: true, module: moduleKey, key: roleKey };
  });
}

/**
 * Adds a resource or replaces its label and actions, which is how a module gains or loses permissions.
 * Actions no longer offered also stop being grantable. One that a role or route still uses is refused by validation.
 */
export function saveResource(actor: Actor, moduleKey: string, resourceKey: string, details: ResourceDetails) {
  return editModuleRules(moduleKey, async (module, session) => {
    const existing = module.resources.find((candidate) => candidate.key === resourceKey);
    const actions = [...new Set(details.actions)] as ManifestResource['actions'];
    const resource = {
      ...existing,
      key: resourceKey,
      label: details.label,
      actions,
      scoped: details.scoped ?? existing?.scoped ?? false,
      grantable: existing?.grantable?.filter((action) => actions.includes(action)) ?? [],
    };
    const resources = existing
      ? module.resources.map((candidate) => (candidate.key === resourceKey ? resource : candidate))
      : [...module.resources, resource];
    await saveRules(actor, module, { resources }, {
      action: existing ? 'module.resource_updated' : 'module.resource_added',
      targetType: 'resource',
      targetId: `${moduleKey}.${resourceKey}`,
      targetName: details.label,
      before: existing ? { label: existing.label, actions: existing.actions } : undefined,
      after: { label: details.label, actions },
    }, session);
    return { created: !existing, module: moduleKey, resource };
  });
}

/** Removes a resource. Validation refuses it while a role or route still uses its permissions. */
export function removeResource(actor: Actor, moduleKey: string, resourceKey: string) {
  return editModuleRules(moduleKey, async (module, session) => {
    const resource = requireResource(module, resourceKey);
    await saveRules(actor, module, { resources: module.resources.filter((candidate) => candidate.key !== resourceKey) }, {
      action: 'module.resource_removed',
      targetType: 'resource',
      targetId: `${moduleKey}.${resourceKey}`,
      targetName: resource.label,
      before: { label: resource.label, actions: resource.actions },
    }, session);
    return { removed: true, module: moduleKey, resource: resourceKey };
  });
}

/**
 * Changes which of a resource's actions can be given to one person. Privileges it no longer allows stop counting.
 * Only a super admin can add to the list, because it decides what others may hand out without one.
 */
export function setGrantableActions(actor: Actor, moduleKey: string, resourceKey: string, actions: string[]) {
  return editModuleRules(moduleKey, async (module, session) => {
    const resource = requireResource(module, resourceKey);
    const grantable = [...new Set(actions)] as ManifestResource['actions'];
    if (!actor.user.superAdmin && grantable.some((action) => !resource.grantable?.includes(action))) {
      throw new ApiError(403, 'beyond_own_access', 'Only a super admin can let more permissions be given to one person.');
    }
    const resources = module.resources.map((candidate) => (candidate.key === resourceKey ? { ...candidate, grantable } : candidate));
    await saveRules(actor, module, { resources }, {
      action: 'module.grantable_changed',
      targetType: 'resource',
      targetId: `${moduleKey}.${resourceKey}`,
      targetName: resource.label,
      before: { grantable: resource.grantable ?? [] },
      after: { grantable },
    }, session);
    return { module: moduleKey, resource: resourceKey, grantable };
  });
}
