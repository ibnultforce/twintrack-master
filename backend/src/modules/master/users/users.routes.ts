import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { paginationQueryFields } from '../../../lib/query.js';
import { parseRequestBody, parseRequestQuery } from '../../../lib/validation.js';
import type { UserReferenceCheck } from '../../../lib/userReferences.js';
import { getActor, getCaller } from '../access/caller.js';
import { sendResetLinks, type PasswordLinkMailer } from '../auth/passwordLinks.service.js';
import { CONTRACTS, USER_STATUSES } from '../models/user.js';
import { GIVE_PROFILE_PERMISSION, listAccessModules, listAddablePeople, listModulePeople, setUserProfile } from './userAccess.service.js';
import { emailField, nameField } from './userFields.js';
import { previewNextEmployeeNumber } from './employeeNumbers.js';
import { createUser, deleteNeverSignedInUser, getUser, listUsers, setUserStatus, updateUserDetails } from './users.service.js';

const MAX_DETAIL_LENGTH = 100;
const MAX_LINKS_PER_REQUEST = 100;
const MAX_EMPLOYEE_NUMBER = 9_999_999;
const READ_PEOPLE = 'user.read';

const detailField = z.string().trim().min(1, 'is required').max(MAX_DETAIL_LENGTH);

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
    employeeNumber: z.number().int().min(1).max(MAX_EMPLOYEE_NUMBER).optional(),
  })
  .refine((details) => Object.keys(details).length > 0, { message: 'send at least one field to change' });

const setStatusBodySchema = z.strictObject({ status: z.enum(USER_STATUSES) });

// null takes the profile away.
const setProfileBodySchema = z.strictObject({ profileId: detailField.nullable() });

const sendLinksBodySchema = z.strictObject({
  userIds: z.array(detailField).min(1, 'name at least one person').max(MAX_LINKS_PER_REQUEST),
});

const userIdFrom = (params: Record<string, unknown>) => String(params.id);

const handleListUsers: RequestHandler = async (req, res) => {
  res.json(await listUsers(getCaller(req), parseRequestQuery(listUsersQuerySchema, req.query)));
};


const handleListAccessModules: RequestHandler = async (_req, res) => {
  res.json({ modules: await listAccessModules() });
};

const handleListModulePeople: RequestHandler = async (req, res) => {
  res.json(await listModulePeople(getActor(req), String(req.params.key)));
};

const handleListAddablePeople: RequestHandler = async (req, res) => {
  res.json(await listAddablePeople(getActor(req), String(req.params.key), parseRequestQuery(addablePeopleQuerySchema, req.query)));
};

const handleGetUser: RequestHandler = async (req, res) => {
  res.json(await getUser(getCaller(req), userIdFrom(req.params)));
};

const handleUpdateUser: RequestHandler = async (req, res) => {
  const details = parseRequestBody(updateUserBodySchema, req.body);
  res.json(await updateUserDetails(getActor(req), userIdFrom(req.params), details));
};

const handleSetStatus: RequestHandler = async (req, res) => {
  const { status } = parseRequestBody(setStatusBodySchema, req.body);
  res.json(await setUserStatus(getActor(req), userIdFrom(req.params), status));
};


const handlePreviewEmployeeNumber: RequestHandler = async (_req, res) => {
  res.json({ employeeNumber: await previewNextEmployeeNumber() });
};

const handleSetProfile: RequestHandler = async (req, res) => {
  const { profileId } = parseRequestBody(setProfileBodySchema, req.body);
  res.json(await setUserProfile(getActor(req), userIdFrom(req.params), profileId));
};

/** referenceChecks come from every module, so a person a module still names is never deleted. */
export function createUsersRoutes(mailer: PasswordLinkMailer, referenceChecks: UserReferenceCheck[]): ApiRoute[] {
  const handleCreateUser: RequestHandler = async (req, res) => {
    const details = parseRequestBody(createUserBodySchema, req.body);
    res.status(201).json(await createUser(mailer, getActor(req), details));
  };

  const handleDeleteUser: RequestHandler = async (req, res) => {
    await deleteNeverSignedInUser(getActor(req), userIdFrom(req.params), referenceChecks);
    res.json({ deleted: true });
  };

  const handleSendPasswordLinks: RequestHandler = async (req, res) => {
    const { userIds } = parseRequestBody(sendLinksBodySchema, req.body);
    res.json({ results: await sendResetLinks(mailer, getActor(req), userIds) });
  };

  return [
    { method: 'GET', path: '/users', access: 'private', permission: 'user.read', handler: handleListUsers },
    { method: 'POST', path: '/users', access: 'private', permission: 'user.create', handler: handleCreateUser },
    // Emails each person a one-time link for setting a new password. Registered before /users/:id.
    { method: 'POST', path: '/users/password-links', access: 'private', permission: 'user.update', handler: handleSendPasswordLinks },
    { method: 'GET', path: '/users/next-employee-number', access: 'private', permission: 'user.create', handler: handlePreviewEmployeeNumber },
    // Registered before /users/:id, which would otherwise read "access-options" as an id.
    { method: 'GET', path: '/users/access-options', access: 'private', anyPermission: [READ_PEOPLE, GIVE_PROFILE_PERMISSION], handler: handleListAccessModules },
    { method: 'GET', path: '/users/:id', access: 'private', permission: 'user.read', handler: handleGetUser },
    { method: 'PATCH', path: '/users/:id', access: 'private', permission: 'user.update', handler: handleUpdateUser },
    // Only for someone who never signed in. Everyone else is deactivated, so their history stays whole.
    { method: 'DELETE', path: '/users/:id', access: 'private', permission: 'user.delete', handler: handleDeleteUser },
    { method: 'PATCH', path: '/users/:id/status', access: 'private', permission: 'user.update', handler: handleSetStatus },
    // userProfile.update is scoped: its scope decides whose profile someone may change. The service checks the rest.
    { method: 'PUT', path: '/users/:id/profile', access: 'private', permission: GIVE_PROFILE_PERMISSION, handler: handleSetProfile },
    { method: 'GET', path: '/modules/:key/people', access: 'private', anyPermission: [READ_PEOPLE, GIVE_PROFILE_PERMISSION], handler: handleListModulePeople },
    { method: 'GET', path: '/modules/:key/addable-people', access: 'private', permission: GIVE_PROFILE_PERMISSION, handler: handleListAddablePeople },
  ];
}
