import type { NextFunction, Request, Response } from 'express';
import { ApiError } from './errors.js';

/** Sends every error in one format. Unexpected errors are logged and never shown to the caller. */
export function handleApiError(err: Error & { status?: number }, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, fields: err.fields } });
    return;
  }
  const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status === 500) req.log.error(err);
  res.status(status).json({
    error: {
      code: status === 500 ? 'server_error' : 'bad_request',
      message: status === 500 ? 'Something went wrong.' : 'The request could not be read.',
    },
  });
}
