import { randomUUID } from 'node:crypto';
import { isDuplicateKeyError, runInTransaction } from '../../../db.js';
import { ApiError } from '../../../lib/errors.js';
import { actorFields, type Actor } from '../access/caller.js';
import { recordAudit } from '../audit/audit.repository.js';
import type { OrgRoleDoc } from '../models/orgRole.js';
import {
  countChildOrgRoles,
  countPeopleByOrgRole,
  countPeopleInOrgRole,
  deleteOrgRole as removeOrgRole,
  findAllOrgRoles,
  findOrgRoleById,
  findOrgRolesBelow,
  findRootOrgRole,
  insertOrgRole,
  saveOrgRolePlacements,
  updateOrgRoleDetails,
} from './orgRoles.repository.js';

export interface OrgRoleView {
  id: string;
  name: string;
  description?: string;
  parentId: string | null;
  /** 0 for the root. */
  depth: number;
  peopleCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewOrgRoleDetails {
  name: string;
  description?: string;
  /** Leave it out only to create the root, when the tree is still empty. */
  parentId?: string;
}

export interface OrgRoleChanges {
  name?: string;
  description?: string | null;
  parentId?: string;
}

const toOrgRoleView = (orgRole: OrgRoleDoc, peopleCount: number): OrgRoleView => ({
  id: orgRole._id,
  name: orgRole.name,
  description: orgRole.description,
  parentId: orgRole.parentId ?? null,
  depth: orgRole.ancestorIds.length,
  peopleCount,
  createdAt: orgRole.createdAt,
  updatedAt: orgRole.updatedAt,
});

const orgRoleTargetFields = (orgRole: Pick<OrgRoleDoc, '_id' | 'name'>) => ({
  targetType: 'orgRole',
  targetId: orgRole._id,
  targetName: orgRole.name,
});

const invalidParent = (message: string) =>
  new ApiError(422, 'validation_failed', 'Some fields are invalid.', [{ path: 'parentId', message }]);

async function requireOrgRole(orgRoleId: string): Promise<OrgRoleDoc> {
  const orgRole = await findOrgRoleById(orgRoleId);
  if (!orgRole) throw new ApiError(404, 'unknown_org_role', 'No such org role.');
  return orgRole;
}

async function requireParent(parentId: string): Promise<OrgRoleDoc> {
  const parent = await findOrgRoleById(parentId);
  if (!parent) throw invalidParent(`org role "${parentId}" does not exist`);
  return parent;
}

/** Moving yourself up the tree would widen whose records you see, so somebody else has to do it. */
function assertNotOwnOrgRole(actor: Actor, orgRole: OrgRoleDoc): void {
  if (!actor.user.superAdmin && actor.user.orgRoleId === orgRole._id) {
    throw new ApiError(403, 'own_org_role', 'Ask another admin to move the role you hold.');
  }
}

/** The whole tree as a flat list, parents before their children, with how many people hold each role. */
export async function listOrgRoles(): Promise<OrgRoleView[]> {
  const [orgRoles, peopleCounts] = await Promise.all([findAllOrgRoles(), countPeopleByOrgRole()]);
  return orgRoles
    .sort((first, second) => first.ancestorIds.length - second.ancestorIds.length)
    .map((orgRole) => toOrgRoleView(orgRole, peopleCounts.get(orgRole._id) ?? 0));
}

export async function createOrgRole(actor: Actor, details: NewOrgRoleDetails): Promise<OrgRoleView> {
  const parent = details.parentId ? await requireParent(details.parentId) : undefined;
  if (!parent && (await findRootOrgRole())) {
    throw invalidParent('the tree already has a root, so a new role needs a parent');
  }

  const record = {
    _id: `or_${randomUUID()}`,
    name: details.name,
    ...(details.description && { description: details.description }),
    ...(parent ? { parentId: parent._id, ancestorIds: [...parent.ancestorIds, parent._id] } : { ancestorIds: [], isRoot: true as const }),
  };
  try {
    const created = await runInTransaction(async (session) => {
      const saved = await insertOrgRole(record, session);
      await recordAudit({ action: 'org_role.created', ...actorFields(actor), ...orgRoleTargetFields(saved), after: details }, session);
      return saved;
    });
    return toOrgRoleView(created, 0);
  } catch (error) {
    // Two requests creating a root at once: the unique index lets only one through.
    if (isDuplicateKeyError(error)) throw invalidParent('the tree already has a root, so a new role needs a parent');
    throw error;
  }
}

/** Works out the new parent and ancestors for a role being moved and for everything below it. */
async function planMove(orgRole: OrgRoleDoc, newParent: OrgRoleDoc) {
  if (orgRole.isRoot) throw invalidParent('the root role cannot be moved');
  if (newParent._id === orgRole._id) throw invalidParent('a role cannot be its own parent');
  if (newParent.ancestorIds.includes(orgRole._id)) throw invalidParent('a role cannot move below one of its own descendants');

  const movedAncestorIds = [...newParent.ancestorIds, newParent._id];
  const descendants = await findOrgRolesBelow(orgRole._id);
  return [
    { orgRoleId: orgRole._id, parentId: newParent._id, ancestorIds: movedAncestorIds },
    ...descendants.map((descendant) => ({
      orgRoleId: descendant._id,
      // Keep the part of the path from the moved role downwards, and replace what was above it.
      ancestorIds: [...movedAncestorIds, ...descendant.ancestorIds.slice(descendant.ancestorIds.indexOf(orgRole._id))],
    })),
  ];
}

export async function updateOrgRole(actor: Actor, orgRoleId: string, changes: OrgRoleChanges): Promise<OrgRoleView> {
  const orgRole = await requireOrgRole(orgRoleId);
  const isMove = changes.parentId !== undefined && changes.parentId !== orgRole.parentId;
  if (isMove) assertNotOwnOrgRole(actor, orgRole);
  const placements = isMove ? await planMove(orgRole, await requireParent(changes.parentId!)) : [];

  const before = { name: orgRole.name, description: orgRole.description ?? null, parentId: orgRole.parentId ?? null };
  const updated = await runInTransaction(async (session) => {
    await saveOrgRolePlacements(placements, session);
    const saved = await updateOrgRoleDetails(orgRole._id, { name: changes.name, description: changes.description }, session);
    await recordAudit(
      { action: isMove ? 'org_role.moved' : 'org_role.updated', ...actorFields(actor), ...orgRoleTargetFields(orgRole), before, after: changes },
      session,
    );
    return saved;
  });
  if (!updated) throw new ApiError(404, 'unknown_org_role', 'No such org role.');
  const peopleCounts = await countPeopleByOrgRole();
  return toOrgRoleView(updated, peopleCounts.get(updated._id) ?? 0);
}

/** Only an empty leaf can go, so nobody is left without a place in the tree. */
export async function deleteOrgRole(actor: Actor, orgRoleId: string): Promise<void> {
  const orgRole = await requireOrgRole(orgRoleId);
  await runInTransaction(async (session) => {
    if ((await countChildOrgRoles(orgRole._id, session)) > 0) {
      throw new ApiError(409, 'org_role_has_children', 'Move or remove the roles below this one first.');
    }
    if ((await countPeopleInOrgRole(orgRole._id, session)) > 0) {
      throw new ApiError(409, 'org_role_in_use', 'Move the people in this role to another role first.');
    }
    await removeOrgRole(orgRole._id, session);
    await recordAudit({ action: 'org_role.deleted', ...actorFields(actor), ...orgRoleTargetFields(orgRole) }, session);
  });
}

/** For the users service: refuses a role that doesn't exist, as a field error on orgRoleId. */
export async function assertOrgRoleExists(orgRoleId: string): Promise<void> {
  if (!(await findOrgRoleById(orgRoleId))) {
    throw new ApiError(422, 'validation_failed', 'Some fields are invalid.', [{ path: 'orgRoleId', message: `org role "${orgRoleId}" does not exist` }]);
  }
}
