import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import type { SecretCipher } from '../../../lib/encryption.js';
import { parseRequestBody } from '../../../lib/validation.js';
import { getActor } from '../../master/access/caller.js';
import { getPermissionScope as scopeOf } from '../../master/access/scope.js';
import { createCredentialService } from './credential.service.js';

const MAX_SHORT_LENGTH = 200;
const MAX_SECRET_LENGTH = 500;
const MAX_NOTES_LENGTH = 5000;

const labelField = z.string().trim().min(1, 'is required').max(MAX_SHORT_LENGTH);
const urlField = z.url('must be an address, such as https://login.salesforce.com').max(MAX_SECRET_LENGTH);
const usernameField = z.string().min(1, 'is required').max(MAX_SHORT_LENGTH);
// Secrets are kept exactly as typed, spaces included.
const secretField = z.string().min(1, 'is required').max(MAX_SECRET_LENGTH);
const notesField = z.string().trim().max(MAX_NOTES_LENGTH);

const createBodySchema = z.strictObject({
  label: labelField,
  loginUrl: urlField,
  username: usernameField,
  password: secretField,
  otpSecret: secretField.optional(),
  passcode: secretField.optional(),
  notes: notesField.optional(),
});

// null clears the one-time code secret, the passcode or the notes.
const updateBodySchema = z
  .strictObject({
    label: labelField.optional(),
    loginUrl: urlField.optional(),
    username: usernameField.optional(),
    password: secretField.optional(),
    otpSecret: secretField.nullable().optional(),
    passcode: secretField.nullable().optional(),
    notes: notesField.nullable().optional(),
    version: z.number().int().min(0).optional(),
  })
  .refine(({ version: _version, ...changes }) => Object.keys(changes).length > 0, { message: 'send at least one field to change' });

const projectIdOf = (params: Record<string, unknown>) => String(params.id);
const credentialIdOf = (params: Record<string, unknown>) => String(params.credentialId);

/** Shared logins for a project's outside systems. The cipher encrypts their secrets. */
export function createCredentialRoutes(cipher: SecretCipher): ApiRoute[] {
  const service = createCredentialService(cipher);

  // Answers that hold passwords must never be stored by a browser or proxy.
  const noStore: RequestHandler = (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  };

  const handleList: RequestHandler = async (req, res) => {
    res.json(await service.listCredentials(getActor(req), scopeOf(req), projectIdOf(req.params)));
  };

  const handleCreate: RequestHandler = async (req, res) => {
    res.status(201).json(await service.createCredential(getActor(req), scopeOf(req), projectIdOf(req.params), parseRequestBody(createBodySchema, req.body)));
  };

  const handleUpdate: RequestHandler = async (req, res) => {
    const edits = parseRequestBody(updateBodySchema, req.body);
    res.json(await service.updateCredential(getActor(req), scopeOf(req), projectIdOf(req.params), credentialIdOf(req.params), edits));
  };

  const handleDelete: RequestHandler = async (req, res) => {
    await service.deleteCredential(getActor(req), scopeOf(req), projectIdOf(req.params), credentialIdOf(req.params));
    res.json({ deleted: true });
  };

  return [
    { method: 'GET', path: '/tasks/projects/:id/credentials', access: 'private', permission: 'credential.read', middleware: [noStore], handler: handleList },
    { method: 'POST', path: '/tasks/projects/:id/credentials', access: 'private', permission: 'credential.create', middleware: [noStore], handler: handleCreate },
    { method: 'PATCH', path: '/tasks/projects/:id/credentials/:credentialId', access: 'private', permission: 'credential.update', middleware: [noStore], handler: handleUpdate },
    { method: 'DELETE', path: '/tasks/projects/:id/credentials/:credentialId', access: 'private', permission: 'credential.delete', handler: handleDelete },
  ];
}
