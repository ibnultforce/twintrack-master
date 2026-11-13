import type { ClientSession } from 'mongoose';
import { runInTransaction } from '../../../db.js';
import { ApiError } from '../../../lib/errors.js';
import { actorFields, type Actor } from '../access/caller.js';
import { findAllProfiles, saveProfileGrants } from '../accessProfiles/accessProfiles.repository.js';
import { recordAudit } from '../audit/audit.repository.js';
import type { AccessProfileDoc } from '../models/accessProfile.js';
import { CustomRecord } from '../models/customRecord.js';
import type { ModuleDoc } from '../models/module.js';
import { validateManifest, type Grants, type ManifestResource } from './manifest.js';
import { findModuleByKey, updateModulePermissionRules } from './moduleRegistry.repository.js';
import { listPermissionUsers } from './grantEditing.js';

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

function requireResource(module: ModuleDoc, resourceKey: string): ManifestResource {
  const resource = module.resources.find((candidate) => candidate.key === resourceKey);
  if (!resource) throw new ApiError(404, 'unknown_resource', `"${resourceKey}" is not a resource in ${module.name}.`);
  return resource;
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
  rules: Pick<ModuleDoc, 'resources'>,
  change: RuleChange,
  session: ClientSession,
): Promise<void> {
  const validated = validateManifest({
    manifestVersion: 1,
    module: { key: module.key, name: module.name, version: module.version },
    routes: module.routes,
    resources: rules.resources,
  });
  // The saved routes only describe the built code, which checks access itself. A super admin may remove an action an API
  // uses, which leaves that API to super admins only, so a route naming a permission no resource offers is allowed here.
  const errors = validated.ok ? [] : validated.errors.filter((error) => !ROUTE_PERMISSION_PATH.test(error.path));
  if (errors.length > 0) throw new ApiError(422, 'validation_failed', 'That would make the module invalid.', errors);

  await updateModulePermissionRules(module.key, rules, session);
  await recordAudit({ ...change, ...actorFields(actor), module: module.key }, session);
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
 * Only a super admin may take away an action something still uses. Profiles then lose it, and an API needing it is
 * left to super admins. Anyone else must first stop profiles using it, and can never remove what a built API needs.
 */
async function removeActions(actor: Actor, module: ModuleDoc, resource: ManifestResource, keptActions: string[], session: ClientSession) {
  const profiles = await findAllProfiles(session);
  if (!actor.user.superAdmin) {
    assertRemovedActionsUnused(module, profiles, resource, keptActions);
    return [];
  }
  return profileChangesWithoutActions(profiles, module.key, resource.key, keptActions);
}

/** Adds a resource or replaces its label and actions, which is how a module gains or loses permissions. */
export function saveResource(actor: Actor, moduleKey: string, resourceKey: string, details: ResourceDetails) {
  return editModuleRules(moduleKey, async (module, session) => {
    const existing = module.resources.find((candidate) => candidate.key === resourceKey);
    if (!actor.permissions[existing ? 'module.update' : 'module.create']) throw new ApiError(403, 'forbidden', 'You do not have permission to do this.');
    const actions = [...new Set(details.actions)] as ManifestResource['actions'];
    const profileChanges = existing ? await removeActions(actor, module, existing, actions, session) : [];
    const resource = { ...existing, key: resourceKey, label: details.label, actions, scoped: details.scoped ?? existing?.scoped ?? false };
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
    await saveProfileGrants(profileChanges, session);
    return { created: !existing, module: moduleKey, resource };
  });
}

/**
 * Refuses to remove a custom object that still has records, including any in the recycle bin. They would be orphaned,
 * and would come back under a new object given the same key.
 */
export async function assertCustomObjectHasNoRecords(moduleKey: string, objectKey: string, session: ClientSession): Promise<void> {
  const records = await CustomRecord.countDocuments({ module: moduleKey, object: objectKey }).setOptions({ withDeleted: true }).session(session);
  if (records > 0) throw new ApiError(409, 'object_in_use', `${records} records use this object. Delete them first.`);
}

/** Removes a resource. Only a super admin can remove one that a profile or API still uses. */
export function removeResource(actor: Actor, moduleKey: string, resourceKey: string) {
  return editModuleRules(moduleKey, async (module, session) => {
    const resource = requireResource(module, resourceKey);
    if (resource.custom === true) await assertCustomObjectHasNoRecords(moduleKey, resourceKey, session);
    const profileChanges = await removeActions(actor, module, resource, [], session);
    await saveRules(actor, module, { resources: module.resources.filter((candidate) => candidate.key !== resourceKey) }, {
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
