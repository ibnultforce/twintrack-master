import type { RequestHandler, Response } from 'express';
import { z } from 'zod';
import type { Config } from '../../../config.js';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { requireAllowedOrigin } from '../../../lib/requireAllowedOrigin.js';
import { parseRequestBody } from '../../../lib/validation.js';
import { getCaller } from '../access/caller.js';
import type { AllowedOrigins } from '../moduleRegistry/allowedOrigins.js';
import { emailField, nameField } from '../users/userFields.js';
import { assertOwnPassword, changeOwnPassword, getProfile, updateOwnName } from './account.service.js';
import { login, logout, refresh, SessionEndedError } from './auth.service.js';
import { createHandoff, exchangeHandoff } from './handoff.service.js';
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
const MAX_URL_LENGTH = 2000;

const createHandoffBodySchema = z.strictObject({
  redirectUrl: z.string().max(MAX_URL_LENGTH).optional(),
});

const exchangeHandoffBodySchema = z.strictObject({
  code: z.string().min(1, 'is required').max(MAX_LINK_TOKEN_LENGTH),
});

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

export function createAuthRoutes(config: Config, allowedOrigins: AllowedOrigins): ApiRoute[] {
  const settings = config.auth;
  const originCheck = requireAllowedOrigin((origin) => allowedOrigins.isAllowed(origin), { allowSameAddress: config.isTestPageEnabled });

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

  const handleCreateHandoff: RequestHandler = async (req, res) => {
    const { redirectUrl } = parseRequestBody(createHandoffBodySchema, req.body ?? {});
    sendTokenResponse(res, await createHandoff(getCaller(req), String(req.params.key), redirectUrl, req.ip));
  };

  const handleExchangeHandoff: RequestHandler = async (req, res) => {
    const { code } = parseRequestBody(exchangeHandoffBodySchema, req.body);
    sendTokenResponse(res, await exchangeHandoff(code, req.get('Origin'), req.ip, settings));
  };

  const handleGetProfile: RequestHandler = async (req, res) => {
    const { user, impersonatorId } = getCaller(req);
    res.json(await getProfile(user, { impersonatorId, isImpersonationEnabled: settings.isImpersonationEnabled }));
  };

  const handleUpdateProfile: RequestHandler = async (req, res) => {
    const { name } = parseRequestBody(updateProfileBodySchema, req.body);
    res.json(await updateOwnName(getCaller(req), name, req.ip, settings));
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
      bodySchema: loginBodySchema, handler: handleLogin,
    },
    { method: 'POST', path: '/auth/refresh', access: 'public', middleware: [originCheck], handler: handleRefresh },
    { method: 'POST', path: '/auth/logout', access: 'public', middleware: [originCheck], handler: handleLogout },
    {
      method: 'POST',
      path: '/auth/set-password',
      access: 'public',
      // The token is the credential here, so wrong ones count as failed attempts.
      middleware: [originCheck, createFailedAttemptLimiter(settings, 'set-password')],
      bodySchema: setPasswordBodySchema, handler: handleSetPassword,
    },
    // The page exchanging the code must be on the address the code was sent to, which the service checks.
    {
      method: 'POST',
      path: '/auth/handoff',
      access: 'public',
      middleware: [createFailedAttemptLimiter(settings, 'handoff')],
      bodySchema: exchangeHandoffBodySchema, handler: handleExchangeHandoff,
    },
    // Signed, not private: anyone with access to the module may open it. The service checks that access.
    { method: 'POST', path: '/modules/:key/handoff', access: 'signed', bodySchema: createHandoffBodySchema, handler: handleCreateHandoff },
    { method: 'GET', path: '/auth/me', access: 'signed', handler: handleGetProfile },
    { method: 'PATCH', path: '/auth/me', access: 'signed', bodySchema: updateProfileBodySchema, handler: handleUpdateProfile },
    {
      method: 'POST',
      path: '/auth/verify-password',
      access: 'signed',
      // Asked for before showing something sensitive, such as a salary. Wrong guesses count as failed attempts.
      middleware: [createFailedAttemptLimiter(settings, 'verify-password')],
      bodySchema: verifyPasswordBodySchema, handler: handleVerifyPassword,
    },
    {
      method: 'POST',
      path: '/auth/change-password',
      access: 'signed',
      middleware: [createFailedAttemptLimiter(settings, 'change-password')],
      bodySchema: changePasswordBodySchema, handler: handleChangePassword,
    },
  ];
}
