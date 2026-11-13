import type { ClientSession } from 'mongoose';
import { ApiError } from '../../../lib/errors.js';
import { escapeRegex, pageOffset, type PageRequest } from '../../../lib/query.js';
import { changeRecord } from '../../../lib/records/recordWrites.js';
import { Client, type ClientDoc, type ClientStatus } from '../models/client.js';

export type NewClientRecord = Pick<ClientDoc, '_id' | 'name'> &
  Partial<Pick<ClientDoc, 'initials' | 'contactEmail' | 'contactPhone' | 'address' | 'notes'>>;

/** For the optional details, null clears the value. */
export type ClientChanges = Partial<Pick<ClientDoc, 'name' | 'status'>> &
  Partial<Record<'initials' | 'contactEmail' | 'contactPhone' | 'address' | 'notes', string | null>>;

export const clientNotFound = () => new ApiError(404, 'unknown_client', 'No such client.');

export const SEARCHED_CLIENT_FIELDS = ['name', 'initials', 'contactEmail'] as const;
export type SearchedClientField = (typeof SEARCHED_CLIENT_FIELDS)[number];

/** searchedFields are the ones the caller may see, so a search can't tell them anything about a hidden field. */
export async function findClientsPage({
  search,
  status,
  searchedFields = SEARCHED_CLIENT_FIELDS,
  ...page
}: PageRequest & { search?: string; status?: ClientStatus; searchedFields?: readonly SearchedClientField[] }) {
  const searchPattern = search ? { $regex: escapeRegex(search), $options: 'i' } : null;
  const filter = {
    ...(status && { status }),
    // With no field to search, nothing matches.
    ...(searchPattern && (searchedFields.length > 0 ? { $or: searchedFields.map((field) => ({ [field]: searchPattern })) } : { _id: { $in: [] } })),
  };
  const [clients, total] = await Promise.all([
    Client.find(filter).sort({ name: 1, _id: 1 }).skip(pageOffset(page)).limit(page.pageSize).lean(),
    Client.countDocuments(filter),
  ]);
  return { clients, total };
}

export const findClientById = (clientId: string) => Client.findById(clientId).lean();

export async function insertClient(record: NewClientRecord, createdBy: string, session: ClientSession): Promise<ClientDoc> {
  const [created] = await Client.create([{ ...record, createdBy, updatedBy: createdBy }], { session });
  if (!created) throw new Error('Creating the client returned nothing.');
  return created.toObject();
}

/** Applies changes, turning a null into removing that detail. */
export function updateClient(clientId: string, changes: ClientChanges, context: { actorId: string; expectedVersion?: number; session: ClientSession }) {
  const entries = Object.entries(changes).filter(([, value]) => value !== undefined);
  const toSet = Object.fromEntries(entries.filter(([, value]) => value !== null));
  const toUnset = Object.fromEntries(entries.filter(([, value]) => value === null).map(([field]) => [field, 1]));
  return changeRecord(Client, clientId, { $set: toSet, ...(Object.keys(toUnset).length > 0 && { $unset: toUnset }) }, context, clientNotFound);
}
