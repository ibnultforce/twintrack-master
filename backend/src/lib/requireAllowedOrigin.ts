import type { Request, RequestHandler } from 'express';
import { ApiError } from './errors.js';

function isFromThisAddress(origin: string, req: Request): boolean {
  return URL.canParse(origin) && new URL(origin).host === req.get('Host');
}

/**
 * Rejects requests from origins that aren't allowed. CORS alone can't protect routes that use the refresh cookie:
 * it only stops a page reading the response, and the request would still run.
 *
 * allowSameAddress also accepts pages served by this API itself, so the test page keeps working behind a tunnel
 * whose address changes. Browsers set Origin themselves, so another site can't claim to be this address.
 */
export function requireAllowedOrigin(allowedOrigins: string[], options: { allowSameAddress?: boolean } = {}): RequestHandler {
  return (req, _res, next) => {
    const origin = req.get('Origin');
    const isAllowed = origin && (allowedOrigins.includes(origin) || (options.allowSameAddress && isFromThisAddress(origin, req)));
    if (!isAllowed) throw new ApiError(403, 'origin_not_allowed', 'This address may not call the API.');
    next();
  };
}
