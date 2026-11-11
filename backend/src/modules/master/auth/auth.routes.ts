import type { RequestHandler, Response } from 'express';
import { z } from 'zod';
import type { Config } from '../../../config.js';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { requireAllowedOrigin } from '../../../lib/requireAllowedOrigin.js';
import { parseRequestBody } from '../../../lib/validation.js';
import { getCaller } from '../access/caller.js';
import { emailField, nameField } from '../users/userFields.js';
import { assertOwnPassword, changeOwnPassword, getProfile, updateOwnName } from './account.service.js';
import { login, logout, refresh, SessionEndedError } from './auth.service.js';
import { setPasswordWithLink } from './passwordLinks.service.js';
import { createFailedAttemptLimiter } from './failedAttemptLimiter.js';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from './passwords.js';
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from './refreshCookie.js';

const loginBodySchema = z.object({
  email: emailField,
  password: z.string().min(1, 'is required').max(MAX_PASSWORD_LENGTH),
});

// Strict, so a request can't slip in other fields such as a role.
const updateProfileBodySchema = z.strictObject({
  name: nameField,
});

const newPasswordField = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `must be at least ${MIN_PASSWORD_LENGTH} characters`)
  .max(MAX_PASSWORD_LENGTH);

const MAX_LINK_TOKEN_LENGTH = 200;

const setPasswordBodySchema = z.strictObject({
  token: z.string().min(1, 'is required').max(MAX_LINK_TOKEN_LENGTH),
  newPassword: newPasswordField,
});

const verifyPasswordBodySchema = z.strictObject({
  password: z.string().min(1, 'is required').max(MAX_PASSWORD_LENGTH),
});

const changePasswordBodySchema = z
  .object({
    currentPassword: z.string().min(1, 'is required').max(MAX_PASSWORD_LENGTH),
    newPassword: newPasswordField,
  })
  .refine((passwords) => passwords.newPassword !== passwords.currentPassword, {
    path: ['newPassword'],
    message: 'must be different from your current password',
  });

// Responses carrying tokens must never be stored by a browser or proxy.
function sendTokenResponse(res: Response, body: object): void {
  res.set('Cache-Control', 'no-store').json(body);
}

export function createAuthRoutes(config: Config): ApiRoute[] {
  const settings = config.auth;
  const originCheck = requireAllowedOrigin(config.allowedOrigins, { allowSameAddress: config.isTestPageEnabled });

  const handleLogin: RequestHandler = async (req, res) => {
    const credentials = parseRequestBody(loginBodySchema, req.body);
    const { refreshCookie, ...result } = await login(credentials, req.ip, settings);
    setRefreshCookie(res, refreshCookie, settings);
    sendTokenResponse(res, result);
  };

  const handleRefresh: RequestHandler = async (req, res) => {
    try {
      const { refreshCookie, ...result } = await refresh(readRefreshCookie(req), req.ip, settings);
      if (refreshCookie) setRefreshCookie(res, refreshCookie, settings);
      sendTokenResponse(res, result);
    } catch (error) {
      if (error instanceof SessionEndedError) clearRefreshCookie(res, settings);
      throw error;
    }
  };

  const handleLogout: RequestHandler = async (req, res) => {
    await logout(readRefreshCookie(req), req.ip);
    clearRefreshCookie(res, settings);
    res.json({ signedOut: true });
  };

  const handleSetPassword: RequestHandler = async (req, res) => {
    const { token, newPassword } = parseRequestBody(setPasswordBodySchema, req.body);
    await setPasswordWithLink(token, newPassword, req.ip);
    res.json({ passwordSet: true });
  };

  const handleGetProfile: RequestHandler = async (req, res) => {
    const { user, impersonatorId } = getCaller(req);
    res.json(await getProfile(user, { impersonatorId, isImpersonationEnabled: settings.isImpersonationEnabled }));
  };

  const handleUpdateProfile: RequestHandler = async (req, res) => {
    const { name } = parseRequestBody(updateProfileBodySchema, req.body);
    res.json(await updateOwnName(getCaller(req), name, req.ip));
  };

  const handleVerifyPassword: RequestHandler = async (req, res) => {
    const { password } = parseRequestBody(verifyPasswordBodySchema, req.body);
    await assertOwnPassword(getCaller(req).user._id, password);
    res.json({ verified: true });
  };

  const handleChangePassword: RequestHandler = async (req, res) => {
    const passwords = parseRequestBody(changePasswordBodySchema, req.body);
    await changeOwnPassword(getCaller(req), passwords, req.ip);
    res.json({ passwordChanged: true });
  };

  return [
    {
      method: 'POST',
      path: '/auth/login',
      access: 'public',
      middleware: [originCheck, createFailedAttemptLimiter(settings, 'login')],
      handler: handleLogin,
    },
    { method: 'POST', path: '/auth/refresh', access: 'public', middleware: [originCheck], handler: handleRefresh },
    { method: 'POST', path: '/auth/logout', access: 'public', middleware: [originCheck], handler: handleLogout },
    {
      method: 'POST',
      path: '/auth/set-password',
      access: 'public',
      // The token is the credential here, so wrong ones count as failed attempts.
      middleware: [originCheck, createFailedAttemptLimiter(settings, 'set-password')],
      handler: handleSetPassword,
    },
    { method: 'GET', path: '/auth/me', access: 'signed', handler: handleGetProfile },
    { method: 'PATCH', path: '/auth/me', access: 'signed', handler: handleUpdateProfile },
    {
      method: 'POST',
      path: '/auth/verify-password',
      access: 'signed',
      // Asked for before showing something sensitive, such as a salary. Wrong guesses count as failed attempts.
      middleware: [createFailedAttemptLimiter(settings, 'verify-password')],
      handler: handleVerifyPassword,
    },
    {
      method: 'POST',
      path: '/auth/change-password',
      access: 'signed',
      middleware: [createFailedAttemptLimiter(settings, 'change-password')],
      handler: handleChangePassword,
    },
  ];
}
