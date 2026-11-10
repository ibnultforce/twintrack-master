import type { ClientSession } from 'mongoose';
import { runInTransaction } from '../../../db.js';
import { ApiError } from '../../../lib/errors.js';
import type { PageRequest } from '../../../lib/query.js';
import { actorFields, type Actor } from '../access/caller.js';
import { listGrantFieldAccess, listGrantPermissions, readOwnEntry, resolveModuleAccess, type Grantee, type PermissionMap } from '../access/permissions.js';
import { findAllProfiles, findProfileIdsGranting } from '../accessProfiles/accessProfiles.repository.js';
import { recordAudit } from '../audit/audit.repository.js';
import type { ModuleDoc } from '../models/module.js';
import type { UserDoc } from '../models/user.js';
import { MASTER_MODULE_KEY } from '../moduleRegistry/manifest.js';
import { findAllModules, findModuleByKey, touchModule } from '../moduleRegistry/moduleRegistry.repository.js';
import { describeGrants } from '../moduleRegistry/permissionSetEditing.js';
import { findUsersAddableTo, findUsersWithAccessIn, updateUserPermissionSets } from './users.repository.js';
import { requireUser, toUserView, userTargetFields, type UserView } from './users.service.js';

/** A module's resource with this key holds its own admin permissions: access.update lets someone change access in it. */
const MODULE_ACCESS_RESOURCE = 'access';

interface AccessRights {
  modules: ModuleDoc[];
  masterPermissions: PermissionMap;
  managesThroughMaster: (moduleKey: string) => boolean;
  isModuleAdmin: (moduleKey: string) => boolean;
}

/** Works out from data alone where this person can change who holds which permission sets. */
async function readAccessRights(grantee: Grantee): Promise<AccessRights> {
  const modules = await findAllModules();
  const master = modules.find((module) => module.key === MASTER_MODULE_KEY);
  const masterPermissions = master ? resolveModuleAccess(grantee, master).permissions : {};
  return {
    modules,
    masterPermissions,
    managesThroughMaster: (moduleKey) =>
      Boolean(masterPermissions['user.update']) ||
      (master?.resources ?? []).some((resource) => resource.managesAccessOf === moduleKey && Boolean(masterPermissions[`${resource.key}.update`])),
    isModuleAdmin: (moduleKey) => {
      const module = modules.find((candidate) => candidate.key === moduleKey);
      return Boolean(module && resolveModuleAccess(grantee, module).permissions[`${MODULE_ACCESS_RESOURCE}.update`]);
    },
  };
}

const canChangeAccessIn = (rights: AccessRights, moduleKey: string) => rights.managesThroughMaster(moduleKey) || rights.isModuleAdmin(moduleKey);

export async function canChangeAnyAccess(grantee: Grantee): Promise<boolean> {
  const rights = await readAccessRights(grantee);
  return rights.modules.some((module) => canChangeAccessIn(rights, module.key));
}

/** Reading the access options needs user.read in Master, or the right to change access somewhere. */
export async function canReadAccessOptions(grantee: Grantee): Promise<boolean> {
  const rights = await readAccessRights(grantee);
  return Boolean(rights.masterPermissions['user.read']) || rights.modules.some((module) => canChangeAccessIn(rights, module.key));
}

/** A super admin can change anyone's access, including their own. Nobody else can change their own or a super admin's. */
async function assertMayChangeAccess(actor: Actor, target: UserDoc, moduleKey: string): Promise<void> {
  if (actor.user.superAdmin) return;
  if (target.superAdmin) throw new ApiError(409, 'super_admin', 'Only a super admin can change a super admin\'s access.');
  if (target._id === actor.user._id) throw new ApiError(403, 'own_access', 'Nobody can change their own access.');

  if (!canChangeAccessIn(await readAccessRights(actor), moduleKey)) {
    throw new ApiError(403, 'module_access_only', 'You can\'t change access in this module.');
  }
}

async function requireModule(moduleKey: string, session?: ClientSession) {
  const module = await findModuleByKey(moduleKey, session);
  if (!module) throw new ApiError(404, 'unknown_module', 'No such module.');
  return module;
}

function assertPermissionSetsExist(module: ModuleDoc, setKeys: string[]): void {
  const unknown = setKeys.filter((setKey) => !module.permissionSets.some((permissionSet) => permissionSet.key === setKey));
  if (unknown.length > 0) {
    throw new ApiError(422, 'unknown_permission_set', `${module.name} has no permission set called ${unknown.map((key) => `"${key}"`).join(', ')}.`);
  }
}

/**
 * What the people screen offers in each module, and whether this caller may change it. Someone who reads people in
 * Master sees every module, and a module admin sees only their own.
 */
export async function listAccessOptions(actor: Actor) {
  const rights = await readAccessRights(actor);
  const seesEverything = Boolean(rights.masterPermissions['user.read']);
  return rights.modules
    .filter((module) => seesEverything || canChangeAccessIn(rights, module.key))
    .map((module) => ({
      key: module.key,
      name: module.name,
      permissionSets: module.permissionSets.map(({ key, name, description, grants }) => ({
        key,
        name,
        description: description ?? '',
        grants: describeGrants(grants, module.resources),
        permissions: listGrantPermissions(grants, module.resources),
        fieldAccess: listGrantFieldAccess(grants, module.resources),
      })),
      canChange: canChangeAccessIn(rights, module.key),
    }));
}

/** The people with access to one module, through their profile or a permission set, for those allowed to see it. */
export async function listModulePeople(actor: Actor, moduleKey: string) {
  const module = await requireModule(moduleKey);
  const rights = await readAccessRights(actor);
  if (!rights.masterPermissions['user.read'] && !canChangeAccessIn(rights, moduleKey)) {
    throw new ApiError(403, 'forbidden', 'You do not have permission to do this.');
  }
  const profiles = await findAllProfiles();
  const profileIdsWithAccess = profiles.filter((profile) => Object.hasOwn(profile.grants, moduleKey)).map((profile) => profile._id);
  const people = await findUsersWithAccessIn(moduleKey, profileIdsWithAccess);
  return {
    module: moduleKey,
    people: people.map((person) => {
      const profile = profiles.find((candidate) => candidate._id === person.profileId);
      const profileGrants = profile ? readOwnEntry(profile.grants, moduleKey) : undefined;
      return {
        id: person._id,
        name: person.name,
        email: person.email,
        status: person.status,
        profile: profile ? { id: profile._id, name: profile.name } : null,
        profilePermissions: profileGrants ? listGrantPermissions(profileGrants, module.resources) : {},
        permissionSets: readOwnEntry(person.permissionSets ?? {}, moduleKey) ?? [],
      };
    }),
  };
}

/**
 * Who this caller could add to a module. A module admin may not be able to read people in Master, so this returns
 * only what's needed to pick someone. Leaves out super admins and the caller, whose access can't be set this way.
 */
export async function listAddablePeople(actor: Actor, moduleKey: string, query: PageRequest & { search?: string }) {
  await requireModule(moduleKey);
  if (!canChangeAccessIn(await readAccessRights(actor), moduleKey)) {
    throw new ApiError(403, 'forbidden', 'You do not have permission to do this.');
  }
  const { users, total } = await findUsersAddableTo(moduleKey, await findProfileIdsGranting(moduleKey), actor.user._id, query);
  return { total, people: users.map(({ _id, name, email, title }) => ({ id: _id, name, email, title })) };
}

/**
 * Replaces the permission sets one person holds in a module. Giving a new one needs a reason, for the activity log.
 * Taking sets away also works for a module that's no longer loaded.
 */
export async function setUserPermissionSets(
  actor: Actor,
  userId: string,
  moduleKey: string,
  change: { permissionSets: string[]; reason?: string },
): Promise<UserView> {
  const target = await requireUser(userId);
  await assertMayChangeAccess(actor, target, moduleKey);

  const setKeys = [...new Set(change.permissionSets)];
  if (setKeys.length > 0) assertPermissionSetsExist(await requireModule(moduleKey), setKeys);

  const currentSets = readOwnEntry(target.permissionSets ?? {}, moduleKey) ?? [];
  const added = setKeys.filter((setKey) => !currentSets.includes(setKey));
  const removed = currentSets.filter((setKey) => !setKeys.includes(setKey));
  if (added.length === 0 && removed.length === 0) return toUserView(target);

  if (added.length > 0 && !change.reason) {
    throw new ApiError(422, 'validation_failed', 'Some fields are invalid.', [
      { path: 'reason', message: 'say why this person needs the permission set' },
    ]);
  }

  const updated = await runInTransaction(async (session) => {
    if (added.length > 0) {
      // Checked again inside the transaction, and the module is written to, so a set being removed at the same time collides with this.
      assertPermissionSetsExist(await requireModule(moduleKey, session), added);
      await touchModule(moduleKey, session);
    }
    const saved = await updateUserPermissionSets(target._id, moduleKey, setKeys, session);
    await recordAudit(
      {
        action: 'user.permission_sets_changed',
        ...actorFields(actor),
        ...userTargetFields(target),
        module: moduleKey,
        reason: change.reason,
        before: { permissionSets: currentSets },
        after: { permissionSets: setKeys },
      },
      session,
    );
    return saved;
  });
  if (!updated) throw new ApiError(404, 'unknown_user', 'No such user.');
  return toUserView(updated);
}
