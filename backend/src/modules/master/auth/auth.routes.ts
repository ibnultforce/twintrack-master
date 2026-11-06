import type { RequestHandler, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type { AuthSettings, Config } from '../../../config.js';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { requireAllowedOrigin } from '../../../lib/requireAllowedOrigin.js';
import { parseRequestBody } from '../../../lib/validation.js';
import { login, logout, refresh, SessionEndedError } from './auth.service.js';
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from './refreshCookie.js';

const MAX_PASSWORD_LENGTH = 256; // Hashing is slow by design, so very long input could be used to overload the server.
const MILLISECONDS_PER_MINUTE = 60_000;

const loginBodySchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email('must be a valid email address')),
  password: z.string().min(1, 'is required').max(MAX_PASSWORD_LENGTH),
});

function createLoginRateLimiter(settings: AuthSettings): RequestHandler {
  return rateLimit({
    windowMs: settings.loginRateWindowMinutes * MILLISECONDS_PER_MINUTE,
    limit: settings.loginMaxFailedAttempts,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: { code: 'too_many_attempts', message: 'Too many failed attempts. Try again later.' } },
  });
}

// Responses carrying tokens must never be stored by a browser or proxy.
function sendTokenResponse(res: Response, body: object): void {
  res.set('Cache-Control', 'no-store').json(body);
}

export function createAuthRoutes(config: Config): ApiRoute[] {
  const settings = config.auth;
  const originCheck = requireAllowedOrigin(config.allowedOrigins);

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

  return [
    {
      method: 'POST',
      path: '/auth/login',
      access: 'public',
      middleware: [originCheck, createLoginRateLimiter(settings)],
      handler: handleLogin,
    },
    { method: 'POST', path: '/auth/refresh', access: 'public', middleware: [originCheck], handler: handleRefresh },
    { method: 'POST', path: '/auth/logout', access: 'public', middleware: [originCheck], handler: handleLogout },
  ];
}
