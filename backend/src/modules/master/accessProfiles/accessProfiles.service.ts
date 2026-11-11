import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import { runInTransaction } from '../../../db.js';
import { ApiError } from '../../../lib/errors.js';
import type { FieldError } from '../../../lib/validation.js';
import { actorFields, type Actor } from '../access/caller.js';
import { listGrantPermissions, listStatedFieldAccess } from '../access/permissions.js';
import { recordAudit } from '../audit/audit.repository.js';
import type { AccessProfileDoc } from '../models/accessProfile.js';
import type { ModuleDoc } from '../models/module.js';
import { checkGrants, grantsSchema, type Grants } from '../moduleRegistry/manifest.js';
import { findAllModules } from '../moduleRegistry/moduleRegistry.repository.js';
import { assertGrantsWithinOwnAccess, describeGrants } from '../moduleRegistry/grantEditing.js';
import {
  countHoldersByProfile,
  countProfileHolders,
  deleteProfile,
  findAllProfiles,
  findProfileById,
  insertProfile,
  replaceProfileFields,
} from './accessProfiles.repository.js';

export interface AccessProfileDetails {
  name: string;
  description?: string;
  /** Module key to that module's grants. Checked against the loaded modules before it's saved. */
  grants: Record<string, unknown>;
}

export type AccessProfileChanges = Partial<Omit<AccessProfileDetails, 'description'>> & { description?: string | null };

const profileTargetFields = (profile: Pick<AccessProfileDoc, '_id' | 'name'>) => ({
  targetType: 'accessProfile',
  targetId: profile._id,
  targetName: profile.name,
});

function toProfileView(profile: AccessProfileDoc, modules: ModuleDoc[], holders: number) {
  return {
    id: profile._id,
    name: profile.name,
    description: profile.description ?? '',
    grants: profile.grants,
    holders,
    modules: Object.entries(profile.grants).map(([moduleKey, grants]) => {
      const module = modules.find((candidate) => candidate.key === moduleKey);
      return {
        key: moduleKey,
        name: module?.name ?? moduleKey,
        loaded: Boolean(module),
        grants: module ? describeGrants(grants, module.resources) : [],
        permissions: module ? listGrantPermissions(grants, module.resources) : {},
        fieldAccess: module ? listStatedFieldAccess(grants, module.resources) : {},
      };
    }),
  };
}

const invalidGrants = (errors: FieldError[]) => new ApiError(422, 'validation_failed', 'Some fields are invalid.', errors);

/**
 * Checks a profile's grants against the loaded modules, and that a caller other than a super admin holds everything
 * they put in it. A module that isn't loaded can't be checked, so it can't be given access.
 */
function validateProfileGrants(actor: Actor, rawGrants: Record<string, unknown>, modules: ModuleDoc[]): Record<string, Grants> {
  const errors: FieldError[] = [];
  const grants: Record<string, Grants> = {};
  for (const [moduleKey, moduleGrants] of Object.entries(rawGrants)) {
    const path = `grants.${moduleKey}`;
    const module = modules.find((candidate) => candidate.key === moduleKey);
    if (!module) {
      errors.push({ path, message: `"${moduleKey}" is not a loaded module` });
      continue;
    }
    const parsed = grantsSchema.safeParse(moduleGrants);
    if (!parsed.success) {
      errors.push(...parsed.error.issues.map((issue) => ({ path: [path, ...issue.path.map(String)].join('.'), message: issue.message })));
      continue;
    }
    errors.push(...checkGrants(parsed.data, module.resources, path));
    grants[moduleKey] = parsed.data;
  }
  if (errors.length > 0) throw invalidGrants(errors);

  for (const [moduleKey, moduleGrants] of Object.entries(grants)) {
    assertGrantsWithinOwnAccess(actor, modules.find((module) => module.key === moduleKey)!, moduleGrants);
  }
  return grants;
}

/** Someone who couldn't build a profile mustn't be able to change or remove one either. */
function assertProfileWithinOwnAccess(actor: Actor, profile: AccessProfileDoc, modules: ModuleDoc[]): void {
  for (const [moduleKey, grants] of Object.entries(profile.grants)) {
    const module = modules.find((candidate) => candidate.key === moduleKey);
    if (module) assertGrantsWithinOwnAccess(actor, module, grants);
    else if (!actor.user.superAdmin) throw new ApiError(403, 'beyond_own_access', `This profile gives access in "${moduleKey}", which isn't loaded, so only a super admin can change it.`);
  }
}

async function requireProfile(profileId: string, session?: ClientSession): Promise<AccessProfileDoc> {
  const profile = await findProfileById(profileId, session);
  if (!profile) throw new ApiError(404, 'unknown_profile', 'No such profile.');
  return profile;
}

export async function listProfiles() {
  const [profiles, modules, holders] = await Promise.all([findAllProfiles(), findAllModules(), countHoldersByProfile()]);
  return profiles.map((profile) => toProfileView(profile, modules, holders.get(profile._id) ?? 0));
}

export async function createProfile(actor: Actor, details: AccessProfileDetails) {
  const modules = await findAllModules();
  const grants = validateProfileGrants(actor, details.grants, modules);
  const record = { _id: `ap_${randomUUID()}`, name: details.name, grants, ...(details.description && { description: details.description }) };

  const created = await runInTransaction(async (session) => {
    const saved = await insertProfile(record, session);
    await recordAudit({ action: 'access_profile.created', ...actorFields(actor), ...profileTargetFields(saved), after: { name: saved.name, grants } }, session);
    return saved;
  });
  return toProfileView(created, modules, 0);
}

/** A change applies to everyone holding the profile on their next request. */
export async function updateProfile(actor: Actor, profileId: string, changes: AccessProfileChanges) {
  const modules = await findAllModules();
  const updated = await runInTransaction(async (session) => {
    const profile = await requireProfile(profileId, session);
    assertProfileWithinOwnAccess(actor, profile, modules);
    const grants = changes.grants ? validateProfileGrants(actor, changes.grants, modules) : profile.grants;
    const description = changes.description === null ? undefined : (changes.description ?? profile.description);
    const fields = { name: changes.name ?? profile.name, grants, description };

    const saved = await replaceProfileFields(profile._id, fields, session);
    await recordAudit(
      {
        action: 'access_profile.updated',
        ...actorFields(actor),
        ...profileTargetFields(profile),
        before: { name: profile.name, description: profile.description, grants: profile.grants },
        after: fields,
      },
      session,
    );
    return saved;
  });
  if (!updated) throw new ApiError(404, 'unknown_profile', 'No such profile.');
  return toProfileView(updated, modules, (await countHoldersByProfile()).get(updated._id) ?? 0);
}

/** Refused while anyone holds it, so nobody loses their baseline access without someone choosing a new profile. */
export async function removeProfile(actor: Actor, profileId: string) {
  const modules = await findAllModules();
  await runInTransaction(async (session) => {
    const profile = await requireProfile(profileId, session);
    assertProfileWithinOwnAccess(actor, profile, modules);
    const holders = await countProfileHolders(profile._id, session);
    if (holders > 0) throw new ApiError(409, 'profile_in_use', `${holders} people have this profile. Give them another profile first.`);
    await deleteProfile(profile._id, session);
    await recordAudit({ action: 'access_profile.removed', ...actorFields(actor), ...profileTargetFields(profile), before: { name: profile.name, grants: profile.grants } }, session);
  });
  return { removed: true, id: profileId };
}

/** For the users service: refuses a profile that doesn't exist, as a field error on profileId. */
export async function assertProfileExists(profileId: string): Promise<void> {
  if (!(await findProfileById(profileId))) throw invalidGrants([{ path: 'profileId', message: `profile "${profileId}" does not exist` }]);
}
