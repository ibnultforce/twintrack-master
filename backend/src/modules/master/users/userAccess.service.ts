import type { ClientSession } from 'mongoose';
import { runInTransaction } from '../../../db.js';
import { ApiError } from '../../../lib/errors.js';
import type { PageRequest } from '../../../lib/query.js';
import { actorFields, type Actor } from '../access/caller.js';
import { listAllPermissions, listGrantablePermissions, resolveModuleAccess, type PermissionMap } from '../access/permissions.js';
import { recordAudit } from '../audit/audit.repository.js';
import type { ModuleDoc } from '../models/module.js';
import type { UserDoc } from '../models/user.js';
import { MASTER_MODULE_KEY } from '../moduleRegistry/manifest.js';
import { findAllModules, findModuleByKey, touchModule } from '../moduleRegistry/moduleRegistry.repository.js';
import { findUsersAddableTo, findUsersWithAccessIn, updateUserPrivileges, updateUserRole } from './users.repository.js';
import { requireUser, toUserView, userTargetFields, type UserView } from './users.service.js';

/** A module's resource with this key holds its own admin permissions: access.update lets someone change access in it. */
const MODULE_ACCESS_RESOURCE = 'access';

interface AccessRights {
  modules: ModuleDoc[];
  masterPermissions: PermissionMap;
  managesThroughMaster: (moduleKey: string) => boolean;
  isModuleAdmin: (moduleKey: string) => boolean;
}

/** Works out from data alone where this person can change access. */
async function readAccessRights(user: UserDoc): Promise<AccessRights> {
  const modules = await findAllModules();
  const master = modules.find((module) => module.key === MASTER_MODULE_KEY);
  const masterPermissions = master ? resolveModuleAccess(user, master).permissions : {};
  return {
    modules,
    masterPermissions,
    managesThroughMaster: (moduleKey) =>
      Boolean(masterPermissions['user.update']) ||
      (master?.resources ?? []).some((resource) => resource.managesAccessOf === moduleKey && Boolean(masterPermissions[`${resource.key}.update`])),
    isModuleAdmin: (moduleKey) => {
      const module = modules.find((candidate) => candidate.key === moduleKey);
      return Boolean(module && resolveModuleAccess(user, module).permissions[`${MODULE_ACCESS_RESOURCE}.update`]);
    },
  };
}

const canChangeAccessIn = (rights: AccessRights, moduleKey: string) => rights.managesThroughMaster(moduleKey) || rights.isModuleAdmin(moduleKey);

export async function canChangeAnyAccess(user: UserDoc): Promise<boolean> {
  const rights = await readAccessRights(user);
  return rights.modules.some((module) => canChangeAccessIn(rights, module.key));
}

/** Reading the access options needs user.read in Master, or the right to change access somewhere. */
export async function canReadAccessOptions(user: UserDoc): Promise<boolean> {
  const rights = await readAccessRights(user);
  return Boolean(rights.masterPermissions['user.read']) || rights.modules.some((module) => canChangeAccessIn(rights, module.key));
}

/** A super admin can change anyone's access, including their own. Nobody else can change their own or a super admin's. */
async function assertMayChangeAccess(actor: Actor, target: UserDoc, moduleKey: string): Promise<void> {
  if (actor.user.superAdmin) return;
  if (target.superAdmin) throw new ApiError(409, 'super_admin', 'Only a super admin can change a super admin\'s access.');
  if (target._id === actor.user._id) throw new ApiError(403, 'own_access', 'Nobody can change their own access.');

  if (!canChangeAccessIn(await readAccessRights(actor.user), moduleKey)) {
    throw new ApiError(403, 'hr_roles_only', 'You can\'t change access in this module.');
  }
}

async function requireModule(moduleKey: string, session?: ClientSession) {
  const module = await findModuleByKey(moduleKey, session);
  if (!module) throw new ApiError(404, 'unknown_module', 'No such module.');
  return module;
}

async function assertRoleExists(moduleKey: string, roleKey: string, session?: ClientSession): Promise<void> {
  const module = await requireModule(moduleKey, session);
  if (!module.roles.some((role) => role.key === roleKey)) {
    throw new ApiError(422, 'unknown_role', `"${roleKey}" is not a role in ${module.name}.`);
  }
}

/**
 * What the people screen offers in each module, and whether this caller may change it. A super admin can give
 * anything. Someone who reads people in Master sees every module, and a module admin sees only their own.
 */
export async function listAccessOptions(actor: Actor) {
  const rights = await readAccessRights(actor.user);
  const seesEverything = Boolean(rights.masterPermissions['user.read']);
  return rights.modules
    .filter((module) => seesEverything || canChangeAccessIn(rights, module.key))
    .map((module) => ({
      key: module.key,
      name: module.name,
      roles: module.roles.map(({ key, name }) => ({ key, name })),
      grantable: actor.user.superAdmin ? listAllPermissions(module.resources) : listGrantablePermissions(module.resources),
      canChange: canChangeAccessIn(rights, module.key),
    }));
}

/** The people with access to one module, for those allowed to read or change it. */
export async function listModulePeople(actor: Actor, moduleKey: string) {
  await requireModule(moduleKey);
  const rights = await readAccessRights(actor.user);
  if (!rights.masterPermissions['user.read'] && !canChangeAccessIn(rights, moduleKey)) {
    throw new ApiError(403, 'forbidden', 'You do not have permission to do this.');
  }
  const people = await findUsersWithAccessIn(moduleKey);
  return {
    module: moduleKey,
    people: people.map((person) => ({
      id: person._id,
      name: person.name,
      email: person.email,
      status: person.status,
      role: person.assignments[moduleKey] ?? null,
      privileges: person.privileges[moduleKey] ?? [],
      superAdminGrants: person.superAdminGrants?.[moduleKey] ?? [],
    })),
  };
}

/**
 * Who this caller could add to a module. A module admin may not be able to read people in Master, so this returns
 * only what's needed to pick someone. Leaves out super admins and the caller, whose access can't be set this way.
 */
export async function listAddablePeople(actor: Actor, moduleKey: string, query: PageRequest & { search?: string }) {
  await requireModule(moduleKey);
  if (!canChangeAccessIn(await readAccessRights(actor.user), moduleKey)) {
    throw new ApiError(403, 'forbidden', 'You do not have permission to do this.');
  }
  const { users, total } = await findUsersAddableTo(moduleKey, actor.user._id, query);
  return { total, people: users.map(({ _id, name, email, title }) => ({ id: _id, name, email, title })) };
}

/** Sets or, with null, removes one person's role. Removing also works for a module that's no longer loaded. */
export async function setUserRole(actor: Actor, userId: string, moduleKey: string, roleKey: string | null): Promise<UserView> {
  const target = await requireUser(userId);
  await assertMayChangeAccess(actor, target, moduleKey);

  if (roleKey !== null) await assertRoleExists(moduleKey, roleKey);

  const currentRole = target.assignments[moduleKey] ?? null;
  if (currentRole === roleKey) return toUserView(target);

  const updated = await runInTransaction(async (session) => {
    if (roleKey !== null) {
      await assertRoleExists(moduleKey, roleKey, session);
      await touchModule(moduleKey, session);
    }
    const saved = await updateUserRole(target._id, moduleKey, roleKey, session);
    await recordAudit(
      {
        action: 'user.role_changed',
        ...actorFields(actor),
        ...userTargetFields(target),
        module: moduleKey,
        before: { role: currentRole },
        after: { role: roleKey },
      },
      session,
    );
    return saved;
  });
  if (!updated) throw new ApiError(404, 'unknown_user', 'No such user.');
  return toUserView(updated);
}

interface PermissionSplit {
  privileges: string[];
  /** Left undefined for other callers, so they can't change what a super admin gave. */
  superAdminGrants?: string[];
}

/** Checks what this caller may give, and separates the module's grantable permissions from super-admin-only ones. */
async function splitAllowedPermissions(actor: Actor, moduleKey: string, permissions: string[]): Promise<PermissionSplit> {
  const isSuperAdmin = actor.user.superAdmin;
  if (permissions.length === 0) return { privileges: [], ...(isSuperAdmin && { superAdminGrants: [] }) };

  const module = await requireModule(moduleKey);
  const grantable = new Set(listGrantablePermissions(module.resources).map(({ permission }) => permission));
  const allowed = isSuperAdmin ? new Set(listAllPermissions(module.resources).map(({ permission }) => permission)) : grantable;
  const refused = permissions.filter((permission) => !allowed.has(permission));
  if (refused.length > 0) {
    throw new ApiError(422, 'not_grantable', `${module.name} doesn't allow this to be granted to one person: ${refused.join(', ')}.`);
  }
  const privileges = permissions.filter((permission) => grantable.has(permission));
  return isSuperAdmin ? { privileges, superAdminGrants: permissions.filter((permission) => !grantable.has(permission)) } : { privileges };
}

/** Replaces one person's special privileges in a module. Giving a new one needs a reason, for the activity log. */
export async function setUserPrivileges(
  actor: Actor,
  userId: string,
  moduleKey: string,
  change: { permissions: string[]; reason?: string },
): Promise<UserView> {
  const target = await requireUser(userId);
  await assertMayChangeAccess(actor, target, moduleKey);

  const permissions = [...new Set(change.permissions)];
  const split = await splitAllowedPermissions(actor, moduleKey, permissions);

  const currentPrivileges = target.privileges[moduleKey] ?? [];
  const currentSuperAdminGrants = target.superAdminGrants?.[moduleKey] ?? [];
  // Other callers only see and replace the privileges, so what a super admin gave is outside their change.
  const currentPermissions = split.superAdminGrants ? [...currentPrivileges, ...currentSuperAdminGrants] : currentPrivileges;
  const added = permissions.filter((permission) => !currentPermissions.includes(permission));
  const removed = currentPermissions.filter((permission) => !permissions.includes(permission));
  if (added.length === 0 && removed.length === 0) return toUserView(target);

  if (added.length > 0 && !change.reason) {
    throw new ApiError(422, 'validation_failed', 'Some fields are invalid.', [
      { path: 'reason', message: 'say why this person needs the privilege' },
    ]);
  }

  const updated = await runInTransaction(async (session) => {
    const saved = await updateUserPrivileges(target._id, moduleKey, split, session);
    await recordAudit(
      {
        action: 'user.privileges_changed',
        ...actorFields(actor),
        ...userTargetFields(target),
        module: moduleKey,
        reason: change.reason,
        before: { permissions: currentPermissions },
        after: { permissions },
      },
      session,
    );
    return saved;
  });
  if (!updated) throw new ApiError(404, 'unknown_user', 'No such user.');
  return toUserView(updated);
}
