import type { ClientSession } from 'mongoose';
import { runInTransaction } from '../../../db.js';
import { ApiError } from '../../../lib/errors.js';
import { actorFields, type Actor } from '../access/caller.js';
import { listGrantFieldAccess, listGrantPermissions, resolveModuleAccess, type Grantee } from '../access/permissions.js';
import { findAllProfiles, saveProfileGrants } from '../accessProfiles/accessProfiles.repository.js';
import { recordAudit } from '../audit/audit.repository.js';
import type { AccessProfileDoc } from '../models/accessProfile.js';
import type { ModuleDoc } from '../models/module.js';
import { countUsersWithPermissionSet } from '../users/users.repository.js';
import { validateManifest, type Grants, type ManifestPermissionSet, type ManifestResource } from './manifest.js';
import { findAllModules, findModuleByKey, updateModulePermissionRules } from './moduleRegistry.repository.js';
import {
  assertGrantsWithinOwnAccess,
  assertMayDoToPermissionSetsIn,
  canDoToPermissionSetsIn,
  canReachPermissionSetsIn,
  describeGrants,
  heldPermissions,
  listPermissionApis,
  listPermissionUsers,
} from './permissionSetEditing.js';

export type PermissionSetChanges = Partial<Pick<ManifestPermissionSet, 'name' | 'description'>> & { grants?: unknown };
export type NewPermissionSet = Pick<ManifestPermissionSet, 'key' | 'name' | 'description'> & { grants: unknown };
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

function requirePermissionSet(module: ModuleDoc, setKey: string): ManifestPermissionSet {
  const permissionSet = module.permissionSets.find((candidate) => candidate.key === setKey);
  if (!permissionSet) throw new ApiError(404, 'unknown_permission_set', `"${setKey}" is not a permission set in ${module.name}.`);
  return permissionSet;
}

function requireResource(module: ModuleDoc, resourceKey: string): ManifestResource {
  const resource = module.resources.find((candidate) => candidate.key === resourceKey);
  if (!resource) throw new ApiError(404, 'unknown_resource', `"${resourceKey}" is not a resource in ${module.name}.`);
  return resource;
}

export async function canReachPermissionSetsSomewhere(grantee: Grantee): Promise<boolean> {
  return (await findAllModules()).some((module) => canReachPermissionSetsIn(grantee, module));
}

const allPermissionsAtFullReach = (module: ModuleDoc) =>
  Object.fromEntries(module.resources.flatMap((resource) => resource.actions.map((action) => [`${resource.key}.${action}`, 'all'])));

/** The modules whose permission sets this person can reach, with what they may do there and put in a set. */
export async function listManageablePermissionSets(actor: Actor) {
  const modules = (await findAllModules()).filter((module) => canReachPermissionSetsIn(actor, module));
  return modules.map((module) => ({
    key: module.key,
    name: module.name,
    resources: module.resources,
    apis: listPermissionApis(module),
    can: {
      create: canDoToPermissionSetsIn(actor, module, 'create'),
      update: canDoToPermissionSetsIn(actor, module, 'update'),
      delete: canDoToPermissionSetsIn(actor, module, 'delete'),
    },
    assignable: actor.user.superAdmin ? allPermissionsAtFullReach(module) : heldPermissions(actor, module),
    /** The protected fields this person may give access to, and how far. */
    assignableFields: resolveModuleAccess(actor, module).fieldAccess,
    permissionSets: module.permissionSets.map((permissionSet) => toPermissionSetView(module, permissionSet)),
  }));
}

/**
 * Runs an edit that reads a module's rules and writes them back. Each edit rewrites a whole list, so the read has to be
 * inside the transaction: when two edits collide, the database retries one of them against the other's result.
 */
export function editModuleRules<Result>(moduleKey: string, edit: (module: ModuleDoc, session: ClientSession) => Promise<Result>): Promise<Result> {
  return runInTransaction(async (session) => edit(await requireModule(moduleKey, session), session));
}

const ROUTE_PERMISSION_PATH = /^routes\.\d+\.(permission|anyPermission)$/;

/** Validates the module with an edit applied, using the same checks as an imported manifest, then saves and records it. */
export async function saveRules(
  actor: Actor,
  module: ModuleDoc,
  rules: Partial<Pick<ModuleDoc, 'permissionSets' | 'resources'>>,
  change: RuleChange,
  session: ClientSession,
  setToKeepWithinAccess?: ManifestPermissionSet,
): Promise<void> {
  const validated = validateManifest({
    manifestVersion: 1,
    module: { key: module.key, name: module.name, version: module.version },
    routes: module.routes,
    permissionSets: rules.permissionSets ?? module.permissionSets,
    resources: rules.resources ?? module.resources,
  });
  // The saved routes only describe the built code, which checks access itself. A super admin may remove an action an API
  // uses, which leaves that API to super admins only, so a route naming a permission no resource offers is allowed here.
  const errors = validated.ok ? [] : validated.errors.filter((error) => !ROUTE_PERMISSION_PATH.test(error.path));
  if (errors.length > 0) throw new ApiError(422, 'validation_failed', 'That would make the module invalid.', errors);
  // After validation, because reading a set's permissions relies on its grants being well formed.
  if (setToKeepWithinAccess) assertGrantsWithinOwnAccess(actor, module, setToKeepWithinAccess.grants, 'permission set');

  await updateModulePermissionRules(module.key, rules, session);
  await recordAudit({ ...change, ...actorFields(actor), module: module.key }, session);
}

const toPermissionSetView = (module: ModuleDoc, permissionSet: ManifestPermissionSet) => ({
  module: module.key,
  moduleName: module.name,
  key: permissionSet.key,
  name: permissionSet.name,
  description: permissionSet.description ?? '',
  grants: describeGrants(permissionSet.grants, module.resources),
  permissions: listGrantPermissions(permissionSet.grants, module.resources),
  fieldAccess: listGrantFieldAccess(permissionSet.grants, module.resources),
});

const setTarget = (moduleKey: string, permissionSet: Pick<ManifestPermissionSet, 'key' | 'name'>) => ({
  targetType: 'permissionSet',
  targetId: `${moduleKey}.${permissionSet.key}`,
  targetName: permissionSet.name,
});

/** Adds a permission set to a module. People can be given it straight away. */
export function addPermissionSet(actor: Actor, moduleKey: string, newSet: NewPermissionSet) {
  return editModuleRules(moduleKey, async (module, session) => {
    assertMayDoToPermissionSetsIn(actor, module, 'create');
    const permissionSet = newSet as ManifestPermissionSet;
    await saveRules(actor, module, { permissionSets: [...module.permissionSets, permissionSet] }, {
      action: 'permission_set.created',
      ...setTarget(moduleKey, permissionSet),
      after: { name: permissionSet.name, grants: permissionSet.grants },
    }, session, permissionSet);
    return toPermissionSetView(module, permissionSet);
  });
}

/** Changes what one permission set allows. It applies to everyone holding it on their next request. */
export function updatePermissionSet(actor: Actor, moduleKey: string, setKey: string, changes: PermissionSetChanges) {
  return editModuleRules(moduleKey, async (module, session) => {
    assertMayDoToPermissionSetsIn(actor, module, 'update');
    const permissionSet = requirePermissionSet(module, setKey);
    assertGrantsWithinOwnAccess(actor, module, permissionSet.grants, 'permission set');
    const edited = { ...permissionSet, ...changes } as ManifestPermissionSet;
    const permissionSets = module.permissionSets.map((candidate) => (candidate.key === setKey ? edited : candidate));
    await saveRules(actor, module, { permissionSets }, {
      action: 'permission_set.updated',
      ...setTarget(moduleKey, edited),
      before: { name: permissionSet.name, description: permissionSet.description, grants: permissionSet.grants },
      after: { name: edited.name, description: edited.description, grants: edited.grants },
    }, session, edited);
    return toPermissionSetView(module, edited);
  });
}

/** Removes a permission set nobody holds, so nobody loses access without someone deciding it. */
export function removePermissionSet(actor: Actor, moduleKey: string, setKey: string) {
  return editModuleRules(moduleKey, async (module, session) => {
    assertMayDoToPermissionSetsIn(actor, module, 'delete');
    const permissionSet = requirePermissionSet(module, setKey);
    assertGrantsWithinOwnAccess(actor, module, permissionSet.grants, 'permission set');
    const holders = await countUsersWithPermissionSet(moduleKey, setKey, session);
    if (holders > 0) throw new ApiError(409, 'permission_set_in_use', `${holders} people have this permission set. Take it away from them first.`);

    await saveRules(actor, module, { permissionSets: module.permissionSets.filter((candidate) => candidate.key !== setKey) }, {
      action: 'permission_set.removed',
      ...setTarget(moduleKey, permissionSet),
      before: { name: permissionSet.name, grants: permissionSet.grants },
    }, session);
    return { removed: true, module: moduleKey, key: setKey };
  });
}

function assertRemovedActionsUnused(module: ModuleDoc, profiles: AccessProfileDoc[], resource: ManifestResource, keptActions: string[]): void {
  const users = listPermissionUsers(module, profiles);
  const problems = resource.actions
    .filter((action) => !keptActions.includes(action))
    .flatMap((action) => {
      const usedBy = users[`${resource.key}.${action}`];
      return usedBy ? [`${action} is used by ${usedBy.join(', ')}`] : [];
    });
  if (problems.length > 0) throw new ApiError(422, 'validation_failed', `These actions can't be removed from ${resource.label}: ${problems.join('; ')}.`);
}

/** Grants with a resource's removed actions taken out, so nothing is left granting what no longer exists. */
function grantsWithoutActions(grants: Grants, resourceKey: string, keptActions: string[]): Grants {
  const grant = grants === '*' ? undefined : grants[resourceKey];
  if (grants === '*' || !grant) return grants;
  const otherGrants = Object.fromEntries(Object.entries(grants).filter(([key]) => key !== resourceKey));
  const actions = grant.actions.filter((action) => keptActions.includes(action));
  return actions.length > 0 ? { ...otherGrants, [resourceKey]: { ...grant, actions } } : otherGrants;
}

/** The profiles whose part for this module changes when a resource loses actions. */
function profileChangesWithoutActions(profiles: AccessProfileDoc[], moduleKey: string, resourceKey: string, keptActions: string[]) {
  return profiles.flatMap((profile) => {
    const grants = Object.hasOwn(profile.grants, moduleKey) ? profile.grants[moduleKey] : undefined;
    if (!grants) return [];
    const trimmed = grantsWithoutActions(grants, resourceKey, keptActions);
    return trimmed === grants ? [] : [{ profileId: profile._id, grants: { ...profile.grants, [moduleKey]: trimmed } }];
  });
}

/**
 * Only a super admin may take away an action something still uses. Permission sets and profiles then lose it, and an
 * API needing it is left to super admins. Anyone else must first stop sets and profiles using it, and can never remove
 * what a built API needs.
 */
async function removeActions(actor: Actor, module: ModuleDoc, resource: ManifestResource, keptActions: string[], session: ClientSession) {
  const profiles = await findAllProfiles(session);
  if (!actor.user.superAdmin) {
    assertRemovedActionsUnused(module, profiles, resource, keptActions);
    return { permissionSets: module.permissionSets, profileChanges: [] };
  }
  return {
    permissionSets: module.permissionSets.map((permissionSet) => ({ ...permissionSet, grants: grantsWithoutActions(permissionSet.grants, resource.key, keptActions) })),
    profileChanges: profileChangesWithoutActions(profiles, module.key, resource.key, keptActions),
  };
}

/** Adds a resource or replaces its label and actions, which is how a module gains or loses permissions. */
export function saveResource(actor: Actor, moduleKey: string, resourceKey: string, details: ResourceDetails) {
  return editModuleRules(moduleKey, async (module, session) => {
    const existing = module.resources.find((candidate) => candidate.key === resourceKey);
    if (!actor.permissions[existing ? 'module.update' : 'module.create']) throw new ApiError(403, 'forbidden', 'You do not have permission to do this.');
    const actions = [...new Set(details.actions)] as ManifestResource['actions'];
    const { permissionSets, profileChanges } = existing
      ? await removeActions(actor, module, existing, actions, session)
      : { permissionSets: module.permissionSets, profileChanges: [] };
    const resource = { ...existing, key: resourceKey, label: details.label, actions, scoped: details.scoped ?? existing?.scoped ?? false };
    const resources = existing
      ? module.resources.map((candidate) => (candidate.key === resourceKey ? resource : candidate))
      : [...module.resources, resource];
    await saveRules(actor, module, { resources, permissionSets }, {
      action: existing ? 'module.resource_updated' : 'module.resource_added',
      targetType: 'resource',
      targetId: `${moduleKey}.${resourceKey}`,
      targetName: details.label,
      before: existing ? { label: existing.label, actions: existing.actions } : undefined,
      after: { label: details.label, actions },
    }, session);
    await saveProfileGrants(profileChanges, session);
    return { created: !existing, module: moduleKey, resource };
  });
}

/** Removes a resource. Only a super admin can remove one that a permission set, profile or API still uses. */
export function removeResource(actor: Actor, moduleKey: string, resourceKey: string) {
  return editModuleRules(moduleKey, async (module, session) => {
    const resource = requireResource(module, resourceKey);
    const { permissionSets, profileChanges } = await removeActions(actor, module, resource, [], session);
    await saveRules(actor, module, { resources: module.resources.filter((candidate) => candidate.key !== resourceKey), permissionSets }, {
      action: 'module.resource_removed',
      targetType: 'resource',
      targetId: `${moduleKey}.${resourceKey}`,
      targetName: resource.label,
      before: { label: resource.label, actions: resource.actions },
    }, session);
    await saveProfileGrants(profileChanges, session);
    return { removed: true, module: moduleKey, resource: resourceKey };
  });
}
