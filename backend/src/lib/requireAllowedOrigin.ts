import type { RequestHandler } from 'express';
import { ApiError } from './errors.js';

/**
 * Rejects requests from origins that aren't allowed. CORS alone can't protect routes that use the refresh cookie:
 * it only stops a page reading the response, and the request would still run.
 */
export function requireAllowedOrigin(allowedOrigins: string[]): RequestHandler {
  return (req, _res, next) => {
    const origin = req.get('Origin');
    if (!origin || !allowedOrigins.includes(origin)) {
      throw new ApiError(403, 'origin_not_allowed', 'This address may not call the API.');
    }
    next();
  };
}
