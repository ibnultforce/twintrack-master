import { runInTransaction } from '../../../db.js';
import { ApiError } from '../../../lib/errors.js';
import type { PageRequest } from '../../../lib/query.js';
import { actorFields, type Actor } from '../access/caller.js';
import { listGrantPermissions, readOwnEntry } from '../access/permissions.js';
import { peopleInScope } from '../access/scope.js';
import { findAllProfiles, findProfileById, findProfileIdsGranting } from '../accessProfiles/accessProfiles.repository.js';
import { recordAudit } from '../audit/audit.repository.js';
import type { UserDoc } from '../models/user.js';
import { assertProfileWithinOwnAccess } from '../moduleRegistry/grantEditing.js';
import { findAllModules, findModuleByKey } from '../moduleRegistry/moduleRegistry.repository.js';
import { findAllOrgRoles } from '../orgRoles/orgRoles.repository.js';
import { findUsersAddableTo, findUsersWithAccessIn, saveUserProfile } from './users.repository.js';
import { requireUser, toUserView, userTargetFields, type UserView } from './users.service.js';

/** The Master permission that lets someone give or take away profiles. Its scope decides whose. */
export const GIVE_PROFILE_PERMISSION = 'userProfile.update';
const READ_PEOPLE_PERMISSION = 'user.read';

/** The people whose profile this person may change, or null for everyone. Without the permission, nobody. */
async function peopleWhoseProfileCanChange(actor: Actor): Promise<string[] | null> {
  const scope = actor.user.superAdmin ? 'all' : actor.permissions[GIVE_PROFILE_PERMISSION];
  if (!scope) return [];
  return peopleInScope(actor.user._id, scope);
}

async function requireModule(moduleKey: string) {
  const module = await findModuleByKey(moduleKey);
  if (!module) throw new ApiError(404, 'unknown_module', 'No such module.');
  return module;
}

/**
 * Only a super admin can change a super admin, or their own profile. Anyone else needs the target inside the scope of
 * their userProfile.update.
 */
async function assertMayChangeProfileOf(actor: Actor, target: UserDoc): Promise<void> {
  if (actor.user.superAdmin) return;
  if (target.superAdmin) throw new ApiError(409, 'super_admin', "Only a super admin can change a super admin's profile.");
  if (target._id === actor.user._id) throw new ApiError(403, 'own_access', 'Nobody can change their own profile.');
  const reachable = await peopleWhoseProfileCanChange(actor);
  if (reachable && !reachable.includes(target._id)) throw new ApiError(403, 'out_of_scope', 'This person is outside what your access reaches.');
}

/**
 * Gives a person a profile, replacing any they had, or takes it away with null. Neither the new profile nor the one
 * being replaced may go beyond the caller's own access.
 */
export async function setUserProfile(actor: Actor, userId: string, profileId: string | null): Promise<UserView> {
  const target = await requireUser(userId);
  await assertMayChangeProfileOf(actor, target);
  if ((target.profileId ?? null) === profileId) return toUserView(target);

  const [current, next] = await Promise.all([
    target.profileId ? findProfileById(target.profileId) : null,
    profileId ? findProfileById(profileId) : null,
  ]);
  if (profileId && !next) throw new ApiError(422, 'validation_failed', 'Some fields are invalid.', [{ path: 'profileId', message: `profile "${profileId}" does not exist` }]);
  if (current) await assertProfileWithinOwnAccess(actor, current);
  if (next) await assertProfileWithinOwnAccess(actor, next);

  const updated = await runInTransaction(async (session) => {
    const saved = await saveUserProfile(target._id, profileId, session);
    await recordAudit(
      {
        action: 'user.profile_changed',
        ...actorFields(actor),
        ...userTargetFields(target),
        before: { profile: current ? current.name : null },
        after: { profile: next ? next.name : null },
      },
      session,
    );
    return saved;
  });
  if (!updated) throw new ApiError(404, 'unknown_user', 'No such user.');
  return toUserView(updated);
}

/** The modules the Access screen can show, for people who read people in Master or give profiles. */
export async function listAccessModules() {
  return (await findAllModules()).map((module) => ({ key: module.key, name: module.name }));
}

/**
 * The people whose profile gives them access to one module, with their place in the org tree. Someone without
 * user.read sees only the people whose profile they may change.
 */
export async function listModulePeople(actor: Actor, moduleKey: string) {
  const module = await requireModule(moduleKey);
  const profiles = await findAllProfiles();
  const profileIdsWithAccess = profiles.filter((profile) => Object.hasOwn(profile.grants, moduleKey)).map((profile) => profile._id);
  const seesEveryone = actor.user.superAdmin || Boolean(actor.permissions[READ_PEOPLE_PERMISSION]);
  const [people, orgRoles, reachable] = await Promise.all([
    findUsersWithAccessIn(profileIdsWithAccess),
    findAllOrgRoles(),
    seesEveryone ? null : peopleWhoseProfileCanChange(actor),
  ]);
  const orgRoleNames = new Map(orgRoles.map((orgRole) => [orgRole._id, orgRole.name]));
  return {
    module: moduleKey,
    people: people
      .filter((person) => !reachable || reachable.includes(person._id))
      .map((person) => {
        const profile = profiles.find((candidate) => candidate._id === person.profileId);
        const profileGrants = profile ? readOwnEntry(profile.grants, moduleKey) : undefined;
        return {
          id: person._id,
          name: person.name,
          email: person.email,
          status: person.status,
          orgRole: person.orgRoleId ? { id: person.orgRoleId, name: orgRoleNames.get(person.orgRoleId) ?? person.orgRoleId } : null,
          profile: profile ? { id: profile._id, name: profile.name } : null,
          profilePermissions: profileGrants ? listGrantPermissions(profileGrants, module.resources) : {},
        };
      }),
  };
}

/**
 * Active people without access to a module whose profile this caller may change, for picking someone to give a
 * profile to. Leaves out super admins and the caller.
 */
export async function listAddablePeople(actor: Actor, moduleKey: string, query: PageRequest & { search?: string }) {
  await requireModule(moduleKey);
  const reachable = await peopleWhoseProfileCanChange(actor);
  const { users, total } = await findUsersAddableTo(await findProfileIdsGranting(moduleKey), actor.user._id, reachable, query);
  return { total, people: users.map(({ _id, name, email, title, profileId }) => ({ id: _id, name, email, title, profileId })) };
}
