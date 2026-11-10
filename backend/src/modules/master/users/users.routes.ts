import type { RequestHandler, Response } from 'express';
import { z } from 'zod';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { paginationQueryFields } from '../../../lib/query.js';
import { parseRequestBody, parseRequestQuery } from '../../../lib/validation.js';
import { getActor, getSignedActor } from '../access/caller.js';
import { refuseUnless } from '../access/refuseUnless.js';
import { CONTRACTS, USER_STATUSES } from '../models/user.js';
import { MODULE_KEY } from '../moduleRegistry/manifest.js';
import {
  canChangeAnyAccess,
  canReadAccessOptions,
  listAccessOptions,
  listAddablePeople,
  listModulePeople,
  setUserPermissionSets,
} from './userAccess.service.js';
import { emailField, nameField } from './userFields.js';
import {
  createUser,
  getUser,
  listUsers,
  resetUserPassword,
  setUserStatus,
  updateUserDetails,
  type TemporaryPasswordResult,
} from './users.service.js';

const MAX_DETAIL_LENGTH = 100;
const MAX_REASON_LENGTH = 500;

const detailField = z.string().trim().min(1, 'is required').max(MAX_DETAIL_LENGTH);
const moduleKeyField = z.string().regex(MODULE_KEY, 'must be a module key');

const listUsersQuerySchema = z.object({
  ...paginationQueryFields,
  search: z.string().trim().max(MAX_DETAIL_LENGTH).optional(),
  status: z.enum(USER_STATUSES).optional(),
});

const addablePeopleQuerySchema = z.object({
  ...paginationQueryFields,
  search: z.string().trim().max(MAX_DETAIL_LENGTH).optional(),
});

// Bodies are strict, so a request can't slip in other fields such as superAdmin or a password hash.
const createUserBodySchema = z.strictObject({
  name: nameField,
  email: emailField,
  title: detailField.optional(),
  department: detailField.optional(),
  team: detailField.optional(),
  contract: z.enum(CONTRACTS).default('permanent'),
  managerId: detailField.optional(),
  // Everyone has a place in the organisation tree, which decides whose records they see.
  orgRoleId: detailField,
  profileId: detailField.optional(),
});

// In an update, null clears an optional detail.
const updateUserBodySchema = z
  .strictObject({
    name: nameField.optional(),
    email: emailField.optional(),
    title: detailField.nullable().optional(),
    department: detailField.nullable().optional(),
    team: detailField.nullable().optional(),
    contract: z.enum(CONTRACTS).optional(),
    managerId: detailField.nullable().optional(),
    orgRoleId: detailField.optional(),
    profileId: detailField.nullable().optional(),
  })
  .refine((details) => Object.keys(details).length > 0, { message: 'send at least one field to change' });

const setStatusBodySchema = z.strictObject({ status: z.enum(USER_STATUSES) });

const setPermissionSetsBodySchema = z.strictObject({
  module: moduleKeyField,
  permissionSets: z.array(z.string().min(1)),
  reason: z.string().trim().min(1).max(MAX_REASON_LENGTH).optional(),
});

// A temporary password must never be stored by a browser or proxy.
function sendTemporaryPassword(res: Response, status: number, result: TemporaryPasswordResult): void {
  res.status(status).set('Cache-Control', 'no-store').json(result);
}

const userIdFrom = (params: Record<string, unknown>) => String(params.id);

const handleListUsers: RequestHandler = async (req, res) => {
  res.json(await listUsers(parseRequestQuery(listUsersQuerySchema, req.query)));
};

const handleCreateUser: RequestHandler = async (req, res) => {
  const details = parseRequestBody(createUserBodySchema, req.body);
  sendTemporaryPassword(res, 201, await createUser(getActor(req), details));
};

const handleListAccessOptions: RequestHandler = async (req, res) => {
  res.json({ modules: await listAccessOptions(getSignedActor(req)) });
};

const handleListModulePeople: RequestHandler = async (req, res) => {
  res.json(await listModulePeople(getSignedActor(req), String(req.params.key)));
};

const handleListAddablePeople: RequestHandler = async (req, res) => {
  res.json(await listAddablePeople(getSignedActor(req), String(req.params.key), parseRequestQuery(addablePeopleQuerySchema, req.query)));
};

const handleGetUser: RequestHandler = async (req, res) => {
  res.json(await getUser(userIdFrom(req.params)));
};

const handleUpdateUser: RequestHandler = async (req, res) => {
  const details = parseRequestBody(updateUserBodySchema, req.body);
  res.json(await updateUserDetails(getActor(req), userIdFrom(req.params), details));
};

const handleSetStatus: RequestHandler = async (req, res) => {
  const { status } = parseRequestBody(setStatusBodySchema, req.body);
  res.json(await setUserStatus(getActor(req), userIdFrom(req.params), status));
};

const handleResetPassword: RequestHandler = async (req, res) => {
  sendTemporaryPassword(res, 200, await resetUserPassword(getActor(req), userIdFrom(req.params)));
};

const handleSetPermissionSets: RequestHandler = async (req, res) => {
  const { module, ...change } = parseRequestBody(setPermissionSetsBodySchema, req.body);
  res.json(await setUserPermissionSets(getSignedActor(req), userIdFrom(req.params), module, change));
};

export const usersRoutes: ApiRoute[] = [
  { method: 'GET', path: '/users', access: 'private', permission: 'user.read', handler: handleListUsers },
  { method: 'POST', path: '/users', access: 'private', permission: 'user.create', handler: handleCreateUser },
  // Registered before /users/:id, which would otherwise read "access-options" as an id.
  { method: 'GET', path: '/users/access-options', access: 'signed', middleware: [refuseUnless(canReadAccessOptions)], handler: handleListAccessOptions },
  { method: 'GET', path: '/users/:id', access: 'private', permission: 'user.read', handler: handleGetUser },
  { method: 'PATCH', path: '/users/:id', access: 'private', permission: 'user.update', handler: handleUpdateUser },
  { method: 'PATCH', path: '/users/:id/status', access: 'private', permission: 'user.update', handler: handleSetStatus },
  { method: 'POST', path: '/users/:id/reset-password', access: 'private', permission: 'user.update', handler: handleResetPassword },
  // These are signed, because a module admin may have no Master access. The services decide who can change what.
  { method: 'PUT', path: '/users/:id/permission-sets', access: 'signed', middleware: [refuseUnless(canChangeAnyAccess)], handler: handleSetPermissionSets },
  { method: 'GET', path: '/modules/:key/people', access: 'signed', middleware: [refuseUnless(canReadAccessOptions)], handler: handleListModulePeople },
  { method: 'GET', path: '/modules/:key/addable-people', access: 'signed', middleware: [refuseUnless(canChangeAnyAccess)], handler: handleListAddablePeople },
];
