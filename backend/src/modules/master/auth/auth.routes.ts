import type { RequestHandler, Response } from 'express';
import { z } from 'zod';
import type { Config } from '../../../config.js';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { requireAllowedOrigin } from '../../../lib/requireAllowedOrigin.js';
import { parseRequestBody } from '../../../lib/validation.js';
import { getCaller } from '../access/caller.js';
import { emailField, nameField } from '../users/userFields.js';
import { changeOwnPassword, getProfile, updateOwnName } from './account.service.js';
import { login, logout, refresh, SessionEndedError } from './auth.service.js';
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

const changePasswordBodySchema = z
  .object({
    currentPassword: z.string().min(1, 'is required').max(MAX_PASSWORD_LENGTH),
    newPassword: z
      .string()
      .min(MIN_PASSWORD_LENGTH, `must be at least ${MIN_PASSWORD_LENGTH} characters`)
      .max(MAX_PASSWORD_LENGTH),
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

  const handleGetProfile: RequestHandler = async (req, res) => {
    res.json(await getProfile(getCaller(req).user));
  };

  const handleUpdateProfile: RequestHandler = async (req, res) => {
    const { name } = parseRequestBody(updateProfileBodySchema, req.body);
    res.json(await updateOwnName(getCaller(req), name, req.ip));
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
      method: 'GET',
      path: '/auth/me',
      access: 'signed',
      // The portal reads mustChangePassword here to know it should show the change-password page.
      allowedDuringPasswordChange: true,
      handler: handleGetProfile,
    },
    { method: 'PATCH', path: '/auth/me', access: 'signed', handler: handleUpdateProfile },
    {
      method: 'POST',
      path: '/auth/change-password',
      access: 'signed',
      allowedDuringPasswordChange: true,
      middleware: [createFailedAttemptLimiter(settings, 'change-password')],
      handler: handleChangePassword,
    },
  ];
}
