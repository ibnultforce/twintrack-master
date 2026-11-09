import type { RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { AuthSettings } from '../../../config.js';
import { MongoRateLimitStore } from './rateLimitStore.js';

const MILLISECONDS_PER_MINUTE = 60_000;

/** Limits password guesses. Each route using it needs its own counter prefix. */
export function createFailedAttemptLimiter(settings: AuthSettings, counterPrefix: string): RequestHandler {
  return rateLimit({
    windowMs: settings.loginRateWindowMinutes * MILLISECONDS_PER_MINUTE,
    limit: settings.loginMaxFailedAttempts,
    skipSuccessfulRequests: true,
    store: new MongoRateLimitStore(counterPrefix),
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: { code: 'too_many_attempts', message: 'Too many failed attempts. Try again later.' } },
  });
}
