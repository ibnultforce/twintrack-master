import type { ClientSession } from 'mongoose';
import { OrgRole, type OrgRoleDoc } from '../models/orgRole.js';
import { User } from '../models/user.js';

export type NewOrgRoleRecord = Pick<OrgRoleDoc, '_id' | 'name' | 'ancestorIds'> & Partial<Pick<OrgRoleDoc, 'description' | 'parentId' | 'isRoot'>>;
export type OrgRoleSeedRow = NewOrgRoleRecord;

export function findAllOrgRoles() {
  return OrgRole.find().sort({ name: 1, _id: 1 }).lean();
}

export function findOrgRoleById(orgRoleId: string, session?: ClientSession) {
  return OrgRole.findById(orgRoleId).session(session ?? null).lean();
}

export function findRootOrgRole(session?: ClientSession) {
  return OrgRole.findOne({ isRoot: true }).session(session ?? null).lean();
}

/** Every role below this one, at any depth. */
export function findOrgRolesBelow(orgRoleId: string, session?: ClientSession) {
  return OrgRole.find({ ancestorIds: orgRoleId }).session(session ?? null).lean();
}

export async function findOrgRoleIdsBelow(orgRoleId: string): Promise<string[]> {
  return OrgRole.find({ ancestorIds: orgRoleId }).distinct('_id');
}

export async function countPeopleByOrgRole(): Promise<Map<string, number>> {
  const counts = await User.aggregate<{ _id: string; count: number }>([
    { $match: { orgRoleId: { $exists: true } } },
    { $group: { _id: '$orgRoleId', count: { $sum: 1 } } },
  ]);
  return new Map(counts.map(({ _id, count }) => [_id, count]));
}

export function countPeopleInOrgRole(orgRoleId: string, session: ClientSession) {
  return User.countDocuments({ orgRoleId }).session(session);
}

export function countChildOrgRoles(orgRoleId: string, session: ClientSession) {
  return OrgRole.countDocuments({ parentId: orgRoleId }).session(session);
}

export async function insertOrgRole(record: NewOrgRoleRecord, session: ClientSession): Promise<OrgRoleDoc> {
  const [created] = await OrgRole.create([record], { session });
  if (!created) throw new Error('Creating the org role returned nothing.');
  return created.toObject();
}

export function updateOrgRoleDetails(orgRoleId: string, changes: { name?: string; description?: string | null }, session: ClientSession) {
  const { description, name } = changes;
  const toSet = { ...(name !== undefined && { name }), ...(typeof description === 'string' && { description }) };
  return OrgRole.findByIdAndUpdate(
    orgRoleId,
    {
      ...(Object.keys(toSet).length > 0 && { $set: toSet }),
      ...(description === null && { $unset: { description: 1 } }),
    },
    { returnDocument: 'after', session },
  ).lean();
}

/** Saves new parents and ancestor lists for a role and everything below it, as worked out by the service. */
export async function saveOrgRolePlacements(
  placements: { orgRoleId: string; parentId?: string; ancestorIds: string[] }[],
  session: ClientSession,
): Promise<void> {
  if (placements.length === 0) return;
  await OrgRole.bulkWrite(
    placements.map(({ orgRoleId, parentId, ancestorIds }) => ({
      updateOne: { filter: { _id: orgRoleId }, update: { $set: { ancestorIds, ...(parentId && { parentId }) } } },
    })),
    { session },
  );
}

export async function deleteOrgRole(orgRoleId: string, session: ClientSession): Promise<void> {
  await OrgRole.deleteOne({ _id: orgRoleId }, { session });
}

/** Creates or updates org roles by id, so the seed is safe to re-run. */
export async function upsertOrgRoles(rows: OrgRoleSeedRow[], session: ClientSession): Promise<void> {
  if (rows.length === 0) return;
  await OrgRole.bulkWrite(
    rows.map(({ _id, ...row }) => {
      const optionalFields = { isRoot: row.isRoot, parentId: row.parentId, description: row.description };
      const missingFields = Object.keys(optionalFields).filter((field) => optionalFields[field as keyof typeof optionalFields] === undefined);
      return {
        updateOne: {
          filter: { _id },
          update: {
            $set: Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined)),
            ...(missingFields.length > 0 && { $unset: Object.fromEntries(missingFields.map((field) => [field, 1])) }),
          },
          upsert: true,
        },
      };
    }),
    { session },
  );
}
