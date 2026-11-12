import type { ClientSession } from 'mongoose';
import { ApiError } from '../../../lib/errors.js';
import { changeRecord, moveToRecycleBin } from '../../../lib/records/recordWrites.js';
import { ProjectCredential, type ProjectCredentialDoc } from '../models/projectCredential.js';

export type NewCredentialRecord = Pick<
  ProjectCredentialDoc,
  '_id' | 'projectId' | 'label' | 'loginUrl' | 'username' | 'passwordEncrypted' | 'otpSecretEncrypted' | 'passcodeEncrypted' | 'notes'
>;

/** For the optional values, null clears them. */
export type CredentialChanges = Partial<Pick<ProjectCredentialDoc, 'label' | 'loginUrl' | 'username' | 'passwordEncrypted'>> &
  Partial<Record<'otpSecretEncrypted' | 'passcodeEncrypted' | 'notes', string | null>>;

export const credentialNotFound = () => new ApiError(404, 'unknown_credential', 'No such login on this project.');

interface WriteContext {
  actorId: string;
  expectedVersion?: number;
  session: ClientSession;
}

export const findCredentialsOf = (projectId: string) => ProjectCredential.find({ projectId }).sort({ createdAt: 1, _id: 1 }).lean();

export const findCredential = (projectId: string, credentialId: string) => ProjectCredential.findOne({ _id: credentialId, projectId }).lean();

export async function insertCredential(record: NewCredentialRecord, createdBy: string, session: ClientSession): Promise<ProjectCredentialDoc> {
  const [created] = await ProjectCredential.create([{ ...record, createdBy, updatedBy: createdBy }], { session });
  if (!created) throw new Error('Creating the credential returned nothing.');
  return created.toObject();
}

export function updateCredential(credentialId: string, changes: CredentialChanges, context: WriteContext) {
  const entries = Object.entries(changes).filter(([, value]) => value !== undefined);
  const toSet = Object.fromEntries(entries.filter(([, value]) => value !== null));
  const toUnset = Object.fromEntries(entries.filter(([, value]) => value === null).map(([field]) => [field, 1]));
  return changeRecord(ProjectCredential, credentialId, { $set: toSet, ...(Object.keys(toUnset).length > 0 && { $unset: toUnset }) }, context, credentialNotFound);
}

export function deleteCredential(credentialId: string, context: WriteContext) {
  return moveToRecycleBin(ProjectCredential, credentialId, context, credentialNotFound);
}
