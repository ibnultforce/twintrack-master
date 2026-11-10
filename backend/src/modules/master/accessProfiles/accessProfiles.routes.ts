import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { parseRequestBody } from '../../../lib/validation.js';
import { getActor } from '../access/caller.js';
import { MODULE_KEY } from '../moduleRegistry/manifest.js';
import { createProfile, listProfiles, removeProfile, updateProfile } from './accessProfiles.service.js';

const MAX_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 500;

const nameField = z.string().trim().min(1, 'is required').max(MAX_NAME_LENGTH);
const descriptionField = z.string().trim().max(MAX_DESCRIPTION_LENGTH);
// Each module's grants are checked against that module by the service, which gives better messages than a schema here could.
const grantsField = z.record(z.string().regex(MODULE_KEY, 'must be a module key'), z.unknown());

const createProfileBodySchema = z.strictObject({
  name: nameField,
  description: descriptionField.optional(),
  grants: grantsField,
});

const updateProfileBodySchema = z
  .strictObject({
    name: nameField.optional(),
    description: descriptionField.nullable().optional(),
    grants: grantsField.optional(),
  })
  .refine((changes) => Object.keys(changes).length > 0, { message: 'send at least one field to change' });

const profileIdFrom = (params: Record<string, unknown>) => String(params.id);

const handleListProfiles: RequestHandler = async (_req, res) => {
  res.json({ profiles: await listProfiles() });
};

const handleCreateProfile: RequestHandler = async (req, res) => {
  res.status(201).json(await createProfile(getActor(req), parseRequestBody(createProfileBodySchema, req.body)));
};

const handleUpdateProfile: RequestHandler = async (req, res) => {
  const changes = parseRequestBody(updateProfileBodySchema, req.body);
  res.json(await updateProfile(getActor(req), profileIdFrom(req.params), changes));
};

const handleRemoveProfile: RequestHandler = async (req, res) => {
  res.json(await removeProfile(getActor(req), profileIdFrom(req.params)));
};

export const accessProfilesRoutes: ApiRoute[] = [
  { method: 'GET', path: '/access-profiles', access: 'private', permission: 'accessProfile.read', handler: handleListProfiles },
  { method: 'POST', path: '/access-profiles', access: 'private', permission: 'accessProfile.create', handler: handleCreateProfile },
  { method: 'PATCH', path: '/access-profiles/:id', access: 'private', permission: 'accessProfile.update', handler: handleUpdateProfile },
  { method: 'DELETE', path: '/access-profiles/:id', access: 'private', permission: 'accessProfile.delete', handler: handleRemoveProfile },
];
