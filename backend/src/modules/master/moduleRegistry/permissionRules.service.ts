import { runInTransaction } from '../../../db.js';
import { ApiError } from '../../../lib/errors.js';
import { actorFields, type Actor } from '../access/caller.js';
import { recordAudit } from '../audit/audit.repository.js';
import type { ModuleDoc } from '../models/module.js';
import { countUsersWithRole } from '../users/users.repository.js';
import { validateManifest, type ManifestResource, type ManifestRole } from './manifest.js';
import { findModuleByKey, updateModulePermissionRules } from './moduleRegistry.repository.js';
import { describeRoleGrants } from './moduleRegistry.service.js';

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

async function requireModule(moduleKey: string): Promise<ModuleDoc> {
  const module = await findModuleByKey(moduleKey);
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

/** Validates the module with an edit applied, using the same checks as an imported manifest, then saves and records it. */
async function saveRules(
  actor: Actor,
  module: ModuleDoc,
  rules: Partial<Pick<ModuleDoc, 'roles' | 'resources'>>,
  change: RuleChange,
): Promise<void> {
  const validated = validateManifest({
    manifestVersion: 1,
    module: { key: module.key, name: module.name, version: module.version },
    routes: module.routes,
    roles: rules.roles ?? module.roles,
    resources: rules.resources ?? module.resources,
  });
  if (!validated.ok) throw new ApiError(422, 'validation_failed', 'That would make the module invalid.', validated.errors);

  await runInTransaction(async (session) => {
    await updateModulePermissionRules(module.key, rules, session);
    await recordAudit({ ...change, ...actorFields(actor), module: module.key }, session);
  });
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
export async function addRole(actor: Actor, moduleKey: string, newRole: NewRole) {
  const module = await requireModule(moduleKey);
  const role = newRole as ManifestRole;
  await saveRules(actor, module, { roles: [...module.roles, role] }, {
    action: 'role.created',
    targetType: 'role',
    targetId: `${moduleKey}.${role.key}`,
    targetName: role.name,
    after: { name: role.name, grants: role.grants },
  });
  return toRoleView(module, role);
}

/** Changes what one role template allows. It applies to everyone with that role on their next request. */
export async function updateRoleTemplate(actor: Actor, moduleKey: string, roleKey: string, changes: RoleTemplateChanges) {
  const module = await requireModule(moduleKey);
  const role = requireRole(module, roleKey);
  const editedRole = { ...role, ...changes } as ManifestRole;
  const roles = module.roles.map((candidate) => (candidate.key === roleKey ? editedRole : candidate));
  await saveRules(actor, module, { roles }, {
    action: 'role.updated',
    targetType: 'role',
    targetId: `${moduleKey}.${roleKey}`,
    targetName: editedRole.name,
    before: { name: role.name, description: role.description, grants: role.grants },
    after: { name: editedRole.name, description: editedRole.description, grants: editedRole.grants },
  });
  return toRoleView(module, editedRole);
}

/** Removes a role nobody holds. Refusing a role in use means nobody loses access without someone choosing their new role. */
export async function removeRole(actor: Actor, moduleKey: string, roleKey: string) {
  const module = await requireModule(moduleKey);
  const role = requireRole(module, roleKey);
  const holders = await countUsersWithRole(moduleKey, roleKey);
  if (holders > 0) throw new ApiError(409, 'role_in_use', `${holders} people have this role. Give them another role first.`);

  await saveRules(actor, module, { roles: module.roles.filter((candidate) => candidate.key !== roleKey) }, {
    action: 'role.removed',
    targetType: 'role',
    targetId: `${moduleKey}.${roleKey}`,
    targetName: role.name,
    before: { name: role.name, grants: role.grants },
  });
  return { removed: true, module: moduleKey, key: roleKey };
}

/**
 * Adds a resource or replaces its label and actions, which is how a module gains or loses permissions.
 * Actions no longer offered also stop being grantable. One that a role or route still uses is refused by validation.
 */
export async function saveResource(actor: Actor, moduleKey: string, resourceKey: string, details: ResourceDetails) {
  const module = await requireModule(moduleKey);
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
  });
  return { created: !existing, module: moduleKey, resource };
}

/** Removes a resource. Validation refuses it while a role or route still uses its permissions. */
export async function removeResource(actor: Actor, moduleKey: string, resourceKey: string) {
  const module = await requireModule(moduleKey);
  const resource = requireResource(module, resourceKey);
  await saveRules(actor, module, { resources: module.resources.filter((candidate) => candidate.key !== resourceKey) }, {
    action: 'module.resource_removed',
    targetType: 'resource',
    targetId: `${moduleKey}.${resourceKey}`,
    targetName: resource.label,
    before: { label: resource.label, actions: resource.actions },
  });
  return { removed: true, module: moduleKey, resource: resourceKey };
}

/** Changes which of a resource's actions can be given to one person. Privileges it no longer allows stop counting. */
export async function setGrantableActions(actor: Actor, moduleKey: string, resourceKey: string, actions: string[]) {
  const module = await requireModule(moduleKey);
  const resource = requireResource(module, resourceKey);
  const grantable = [...new Set(actions)] as ManifestResource['actions'];
  const resources = module.resources.map((candidate) => (candidate.key === resourceKey ? { ...candidate, grantable } : candidate));
  await saveRules(actor, module, { resources }, {
    action: 'module.grantable_changed',
    targetType: 'resource',
    targetId: `${moduleKey}.${resourceKey}`,
    targetName: resource.label,
    before: { grantable: resource.grantable ?? [] },
    after: { grantable },
  });
  return { module: moduleKey, resource: resourceKey, grantable };
}
