import type { RequestHandler } from 'express';
import type { AuthSettings } from '../../../config.js';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { getCaller } from '../access/caller.js';
import { startImpersonation, stopImpersonation } from './impersonation.service.js';

/** Development only: the service refuses both routes unless IMPERSONATION_ENABLED is true, which production forbids. */
export function createImpersonationRoutes(settings: AuthSettings): ApiRoute[] {
  const handleStart: RequestHandler = async (req, res) => {
    res.set('Cache-Control', 'no-store').json(await startImpersonation(getCaller(req), String(req.params.id), settings, req.ip));
  };

  const handleStop: RequestHandler = async (req, res) => {
    res.set('Cache-Control', 'no-store').json(await stopImpersonation(getCaller(req), settings, req.ip));
  };

  return [
    // Signed, because it is for super admins, which the service checks.
    { method: 'POST', path: '/users/:id/impersonate', access: 'signed', handler: handleStart },
    { method: 'POST', path: '/auth/stop-impersonating', access: 'signed', handler: handleStop },
  ];
}
