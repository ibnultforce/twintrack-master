import cors from 'cors';
import type { RequestHandler } from 'express';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { ApiError } from '../../../lib/errors.js';
import { contentDisposition } from '../../../lib/storage/fileStorage.js';
import { LOCAL_CONTENT_PATH, LOCAL_PART_PATH, UploadClosedError, type LocalStorage } from '../../../lib/storage/localStorage.js';

const invalidLink = () => new ApiError(403, 'invalid_file_link', 'This file link is invalid or has expired.');

/**
 * Stand-ins for R2's signed addresses when files are on the local disk, in development. The signed token in the
 * address is the credential, as with R2, so these are public. With R2 in use, they answer 404.
 */
export function createStorageRoutes(localStorage: LocalStorage | undefined, allowedOrigins: string[]): ApiRoute[] {
  // The browser reads the ETag of each part, which CORS hides unless it is listed.
  const exposeEtag = cors({ origin: allowedOrigins, exposedHeaders: ['ETag'] });

  const readGrant = (token: unknown) => {
    if (!localStorage) throw new ApiError(404, 'no_route', 'No such route.');
    const grant = typeof token === 'string' ? localStorage.readGrant(token) : null;
    if (!grant) throw invalidLink();
    return grant;
  };

  const handleSavePart: RequestHandler = async (req, res) => {
    const grant = readGrant(req.query.token);
    if (grant.kind !== 'part' || !localStorage) throw invalidLink();
    // Anything else, such as a full disk or a dropped connection, is a server error, logged by the error handler.
    const etag = await localStorage.savePart(grant, req).catch((error: unknown) => {
      if (error instanceof UploadClosedError) throw new ApiError(409, 'upload_closed', 'This upload has already finished or been cancelled.');
      throw error;
    });
    res.set('ETag', etag).status(200).end();
  };

  const handleContent: RequestHandler = (req, res) => {
    const grant = readGrant(req.query.token);
    if (grant.kind !== 'content' || !localStorage) throw invalidLink();
    // Set here, not from the file name, so a file the service chose to download can never be shown as a page.
    res.sendFile(localStorage.pathOf(grant.key), {
      headers: { 'Content-Type': grant.contentType, 'Content-Disposition': contentDisposition(grant), 'Cache-Control': 'private, max-age=60', 'X-Content-Type-Options': 'nosniff' },
    });
  };

  return [
    { method: 'PUT', path: LOCAL_PART_PATH, access: 'public', middleware: [exposeEtag], handler: handleSavePart },
    { method: 'GET', path: LOCAL_CONTENT_PATH, access: 'public', handler: handleContent },
  ];
}
