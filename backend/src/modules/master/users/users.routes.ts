import type { RequestHandler, Response } from 'express';
import { z } from 'zod';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { paginationQueryFields } from '../../../lib/query.js';
import { parseRequestBody, parseRequestQuery } from '../../../lib/validation.js';
import { ApiError } from '../../../lib/errors.js';
import { getActor, getCaller, getSignedActor } from '../access/caller.js';
import { CONTRACTS, USER_STATUSES, type UserDoc } from '../models/user.js';
import { MODULE_KEY } from '../moduleRegistry/manifest.js';
import {
  canChangeAnyAccess,
  canReadAccessOptions,
  listAccessOptions,
  listModulePeople,
  setUserPrivileges,
  setUserRole,
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

// Bodies are strict, so a request can't slip in other fields such as superAdmin or a password hash.
const createUserBodySchema = z.strictObject({
  name: nameField,
  email: emailField,
  title: detailField.optional(),
  department: detailField.optional(),
  team: detailField.optional(),
  contract: z.enum(CONTRACTS).default('permanent'),
  managerId: detailField.optional(),
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
  })
  .refine((details) => Object.keys(details).length > 0, { message: 'send at least one field to change' });

const setStatusBodySchema = z.strictObject({ status: z.enum(USER_STATUSES) });

const setRoleBodySchema = z.strictObject({
  module: moduleKeyField,
  role: z.string().min(1, 'is required').nullable(),
});

const setPrivilegesBodySchema = z.strictObject({
  module: moduleKeyField,
  permissions: z.array(z.string().min(1)),
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

/** Runs before the body is read, so someone with no rights is refused the same way as on a private route. */
const refuseUnless = (isAllowed: (user: UserDoc) => Promise<boolean>): RequestHandler => async (req, _res, next) => {
  if (!(await isAllowed(getCaller(req).user))) throw new ApiError(403, 'forbidden', 'You do not have permission to do this.');
  next();
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

const handleSetRole: RequestHandler = async (req, res) => {
  const { module, role } = parseRequestBody(setRoleBodySchema, req.body);
  res.json(await setUserRole(getSignedActor(req), userIdFrom(req.params), module, role));
};

const handleSetPrivileges: RequestHandler = async (req, res) => {
  const { module, ...change } = parseRequestBody(setPrivilegesBodySchema, req.body);
  res.json(await setUserPrivileges(getSignedActor(req), userIdFrom(req.params), module, change));
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
  // These are signed, because a module admin may have no Master role. The services decide who can change what.
  { method: 'PATCH', path: '/users/:id/roles', access: 'signed', middleware: [refuseUnless(canChangeAnyAccess)], handler: handleSetRole },
  { method: 'PUT', path: '/users/:id/privileges', access: 'signed', middleware: [refuseUnless(canChangeAnyAccess)], handler: handleSetPrivileges },
  { method: 'GET', path: '/modules/:key/people', access: 'signed', middleware: [refuseUnless(canReadAccessOptions)], handler: handleListModulePeople },
];
