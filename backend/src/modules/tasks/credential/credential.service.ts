import { randomUUID } from 'node:crypto';
import { runInTransaction } from '../../../db.js';
import type { SecretCipher } from '../../../lib/encryption.js';
import { ApiError } from '../../../lib/errors.js';
import { parseOtpSecret, totpCode } from '../../../lib/totp.js';
import { actorFields, type Actor } from '../../master/access/caller.js';
import { recordAudit } from '../../master/audit/audit.repository.js';
import type { Scope } from '../../master/moduleRegistry/manifest.js';
import { assertMayWriteFields, readFieldRules, redactRecord, type FieldRules } from '../../master/records/fieldSecurity.service.js';
import { assertCanReachRecord, type RecordNeed } from '../../master/records/recordAccess.service.js';
import { writeRecordHistory } from '../../master/records/recordHistory.service.js';
import type { ProjectDoc } from '../models/project.js';
import type { ProjectCredentialDoc } from '../models/projectCredential.js';
import { projectPeople, requireProject } from '../project/project.service.js';
import { findPeopleNames, TASKS_MODULE_KEY } from '../tasksModule.js';
import {
  credentialNotFound,
  deleteCredential as moveCredentialToRecycleBin,
  findCredential,
  findCredentialsOf,
  insertCredential,
  updateCredential as saveCredentialChanges,
  type CredentialChanges,
} from './credential.repository.js';

const CREDENTIAL_RESOURCE = 'credential';

/** What someone sends: secrets in plain text, which are encrypted before they are saved. */
export interface CredentialDetails {
  label: string;
  loginUrl: string;
  username: string;
  password: string;
  /** An otpauth:// link or a base32 secret. */
  otpSecret?: string;
  passcode?: string;
  notes?: string;
}

export type CredentialEdits = Partial<Pick<CredentialDetails, 'label' | 'loginUrl' | 'username' | 'password'>> &
  Partial<Record<'otpSecret' | 'passcode' | 'notes', string | null>> & { version?: number };

const fieldRulesFor = (actor: Actor) => readFieldRules(actor, TASKS_MODULE_KEY, CREDENTIAL_RESOURCE);
const historyRef = (credentialId: string) => ({ module: TASKS_MODULE_KEY, object: CREDENTIAL_RESOURCE, recordId: credentialId });

/** Logins belong to the project's people, so a scope reaching any of them reaches its logins. */
const assertCanReachLogins = (actor: Actor, scope: Scope, project: ProjectDoc, credentialId: string, need: RecordNeed) =>
  assertCanReachRecord(actor, scope, { ...historyRef(credentialId), peopleIds: projectPeople(project) }, need);

/** Field names the API and field access use. Each stored secret has a plain name, such as password. */
const FIELD_OF_INPUT: Record<string, string> = { otpSecret: 'otpCode' };
const writtenFields = (input: object) => Object.keys(input).filter((field) => field !== 'version').map((field) => FIELD_OF_INPUT[field] ?? field);

function encryptOtpSecret(cipher: SecretCipher, otpSecret: string): string {
  const secret = parseOtpSecret(otpSecret);
  if (!secret) {
    throw new ApiError(422, 'validation_failed', 'Some fields are invalid.', [
      { path: 'otpSecret', message: 'must be an otpauth:// link or the secret from the authenticator setup' },
    ]);
  }
  return cipher.encrypt(secret);
}

function toCredentialView(cipher: SecretCipher, credential: ProjectCredentialDoc, names: Map<string, string>, rules: FieldRules) {
  const otp = credential.otpSecretEncrypted ? totpCode(cipher.decrypt(credential.otpSecretEncrypted)) : undefined;
  return redactRecord(
    {
      id: credential._id,
      projectId: credential.projectId,
      label: credential.label,
      loginUrl: credential.loginUrl,
      username: credential.username,
      password: cipher.decrypt(credential.passwordEncrypted),
      passcode: credential.passcodeEncrypted ? cipher.decrypt(credential.passcodeEncrypted) : undefined,
      hasOtp: Boolean(otp),
      // The current code and how long it lasts. The secret behind it is never sent.
      otpCode: otp?.code,
      otpSecondsRemaining: otp?.secondsRemaining,
      notes: credential.notes,
      version: credential.version,
      createdBy: credential.createdBy,
      createdByName: credential.createdBy ? names.get(credential.createdBy) : undefined,
      createdAt: credential.createdAt,
      updatedBy: credential.updatedBy,
      updatedByName: credential.updatedBy ? names.get(credential.updatedBy) : undefined,
      updatedAt: credential.updatedAt,
    },
    rules,
  );
}

const credentialAuditFields = (actor: Actor, credential: ProjectCredentialDoc) => ({
  ...actorFields(actor),
  targetType: CREDENTIAL_RESOURCE,
  targetId: credential._id,
  targetName: credential.label,
  module: TASKS_MODULE_KEY,
});

const peopleOf = (credentials: ProjectCredentialDoc[]) => credentials.flatMap((credential) => [credential.createdBy, credential.updatedBy]).filter((id): id is string => Boolean(id));

export function createCredentialService(cipher: SecretCipher) {
  async function requireCredential(projectId: string, credentialId: string) {
    const credential = await findCredential(projectId, credentialId);
    if (!credential) throw credentialNotFound();
    return credential;
  }

  async function listCredentials(actor: Actor, scope: Scope, projectId: string) {
    const project = await requireProject(projectId);
    await assertCanReachLogins(actor, scope, project, projectId, 'read');
    const credentials = await findCredentialsOf(projectId);
    const [names, rules] = await Promise.all([findPeopleNames(peopleOf(credentials)), fieldRulesFor(actor)]);
    return { credentials: credentials.map((credential) => toCredentialView(cipher, credential, names, rules)) };
  }

  async function createCredential(actor: Actor, scope: Scope, projectId: string, details: CredentialDetails) {
    const project = await requireProject(projectId);
    const credentialId = `pc_${randomUUID()}`;
    await assertCanReachLogins(actor, scope, project, credentialId, 'edit');
    const rules = await fieldRulesFor(actor);
    assertMayWriteFields(rules, writtenFields(details), 'create');

    const { password, otpSecret, passcode, ...plain } = details;
    const credential = await runInTransaction(async (session) => {
      const created = await insertCredential(
        {
          ...plain,
          _id: credentialId,
          projectId,
          passwordEncrypted: cipher.encrypt(password),
          ...(otpSecret && { otpSecretEncrypted: encryptOtpSecret(cipher, otpSecret) }),
          ...(passcode && { passcodeEncrypted: cipher.encrypt(passcode) }),
        },
        actor.user._id,
        session,
      );
      // History keeps only the tracked fields in the manifest, which leave the secrets out.
      await writeRecordHistory(historyRef(created._id), { action: 'created', actor, after: created }, session);
      await recordAudit({ action: 'credential.created', ...credentialAuditFields(actor, created) }, session);
      return created;
    });
    return toCredentialView(cipher, credential, await findPeopleNames(peopleOf([credential])), rules);
  }

  async function updateCredential(actor: Actor, scope: Scope, projectId: string, credentialId: string, edits: CredentialEdits) {
    const { version, password, otpSecret, passcode, ...plain } = edits;
    const project = await requireProject(projectId);
    const existing = await requireCredential(projectId, credentialId);
    await assertCanReachLogins(actor, scope, project, credentialId, 'edit');
    const rules = await fieldRulesFor(actor);
    assertMayWriteFields(rules, writtenFields(edits), 'update');

    const changes: CredentialChanges = {
      ...plain,
      ...(password !== undefined && { passwordEncrypted: cipher.encrypt(password) }),
      ...(otpSecret !== undefined && { otpSecretEncrypted: otpSecret ? encryptOtpSecret(cipher, otpSecret) : null }),
      ...(passcode !== undefined && { passcodeEncrypted: passcode ? cipher.encrypt(passcode) : null }),
    };
    const saved = await runInTransaction(async (session) => {
      const result = await saveCredentialChanges(credentialId, changes, { actorId: actor.user._id, expectedVersion: version, session });
      await writeRecordHistory(historyRef(credentialId), { action: 'updated', actor, before: existing, after: result }, session);
      await recordAudit({ action: 'credential.updated', ...credentialAuditFields(actor, result) }, session);
      return result;
    });
    return toCredentialView(cipher, saved, await findPeopleNames(peopleOf([saved])), rules);
  }

  /** Moves a login to the recycle bin, where it stays restorable with its history. */
  async function deleteCredential(actor: Actor, scope: Scope, projectId: string, credentialId: string) {
    const project = await requireProject(projectId);
    const existing = await requireCredential(projectId, credentialId);
    await assertCanReachLogins(actor, scope, project, credentialId, 'edit');
    await runInTransaction(async (session) => {
      await moveCredentialToRecycleBin(credentialId, { actorId: actor.user._id, session });
      await writeRecordHistory(historyRef(credentialId), { action: 'deleted', actor, before: existing }, session);
      await recordAudit({ action: 'credential.deleted', ...credentialAuditFields(actor, existing) }, session);
    });
  }

  return { listCredentials, createCredential, updateCredential, deleteCredential };
}
