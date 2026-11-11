import express, { type RequestHandler } from 'express';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { getCaller } from '../access/caller.js';
import { PHOTO_CONTENT_TYPES } from '../models/userPhoto.js';
import { getUserPhoto, MAX_PHOTO_BYTES, removeUserPhoto, setUserPhoto } from './photos.service.js';

// Reads the image as raw bytes. Any other content type leaves the body empty, which the service refuses.
const readImageBody = express.raw({ type: [...PHOTO_CONTENT_TYPES], limit: MAX_PHOTO_BYTES });

const userIdFrom = (params: Record<string, unknown>) => String(params.id);

const handleGetPhoto: RequestHandler = async (req, res) => {
  const photo = await getUserPhoto(userIdFrom(req.params));
  // Private, because it needs a session. A short life, so a new photo soon shows in every tab.
  res.set({ 'Content-Type': photo.contentType, 'Cache-Control': 'private, max-age=300', 'Last-Modified': photo.updatedAt.toUTCString() });
  res.send(photo.data);
};

const handleSetPhoto: RequestHandler = async (req, res) => {
  const image = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  res.json(await setUserPhoto(getCaller(req), userIdFrom(req.params), image, req.ip));
};

const handleRemovePhoto: RequestHandler = async (req, res) => {
  await removeUserPhoto(getCaller(req), userIdFrom(req.params), req.ip);
  res.json({ removed: true });
};

/** Signed routes: the service lets people change their own photo, and anyone's with user.update. */
export const photoRoutes: ApiRoute[] = [
  { method: 'GET', path: '/users/:id/photo', access: 'signed', handler: handleGetPhoto },
  { method: 'PUT', path: '/users/:id/photo', access: 'signed', middleware: [readImageBody], handler: handleSetPhoto },
  { method: 'DELETE', path: '/users/:id/photo', access: 'signed', handler: handleRemovePhoto },
];
