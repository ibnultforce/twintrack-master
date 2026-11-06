import type { CookieOptions, Request, Response } from 'express';
import type { AuthSettings } from '../../../config.js';

const REFRESH_COOKIE_NAME = 'twintrack_refresh';

// No domain is set, so the cookie stays with the API's own host and never reaches a frontend.
const cookieOptions = (settings: AuthSettings): CookieOptions => ({
  httpOnly: true,
  secure: settings.isRefreshCookieSecure,
  sameSite: 'strict',
  path: '/auth',
});

export function readRefreshCookie(req: Request): string | undefined {
  const value: unknown = req.cookies?.[REFRESH_COOKIE_NAME];
  return typeof value === 'string' ? value : undefined;
}

export function setRefreshCookie(res: Response, cookie: { token: string; expiresAt: Date }, settings: AuthSettings): void {
  res.cookie(REFRESH_COOKIE_NAME, cookie.token, { ...cookieOptions(settings), expires: cookie.expiresAt });
}

export function clearRefreshCookie(res: Response, settings: AuthSettings): void {
  res.clearCookie(REFRESH_COOKIE_NAME, cookieOptions(settings));
}
