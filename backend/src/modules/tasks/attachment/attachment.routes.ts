import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import type { FileStorage } from '../../../lib/storage/fileStorage.js';
import { parseRequestBody, parseRequestQuery } from '../../../lib/validation.js';
import { getActor } from '../../master/access/caller.js';
import { getPermissionScope as scopeOf } from '../../master/access/scope.js';
import { createAttachmentService, TASK_ATTACHMENT_LIMIT_BYTES } from './attachment.service.js';

const MAX_PART_NUMBER = 10_000;
const MAX_PARTS_PER_REQUEST = 100;

const startBodySchema = z.strictObject({
  fileName: z.string().trim().min(1, 'is required').max(255),
  mimeType: z.string().max(255).optional(),
  sizeBytes: z.number().int().positive().max(TASK_ATTACHMENT_LIMIT_BYTES),
});

const partNumberField = z.number().int().min(1).max(MAX_PART_NUMBER);
const partUrlsBodySchema = z.strictObject({ partNumbers: z.array(partNumberField).min(1).max(MAX_PARTS_PER_REQUEST) });
const completeBodySchema = z.strictObject({
  parts: z.array(z.strictObject({ partNumber: partNumberField, etag: z.string().min(1).max(200) })).min(1).max(MAX_PART_NUMBER),
});
const urlQuerySchema = z.object({ mode: z.enum(['view', 'download']).default('view') });

const ids = (params: Record<string, unknown>) => ({ taskId: String(params.id), attachmentId: String(params.attachmentId) });

/**
 * Files on tasks. Each route needs only task.read, because adding a file is like adding a comment. The service limits
 * unfinished uploads to their uploader, and removing someone else's file to people who can edit the task.
 */
export function createAttachmentRoutes(storage: FileStorage): ApiRoute[] {
  const service = createAttachmentService(storage);

  const handleList: RequestHandler = async (req, res) => {
    res.json(await service.listAttachments(getActor(req), scopeOf(req), String(req.params.id)));
  };

  const handleStart: RequestHandler = async (req, res) => {
    res.status(201).json(await service.startUpload(getActor(req), scopeOf(req), String(req.params.id), parseRequestBody(startBodySchema, req.body)));
  };

  const handlePartUrls: RequestHandler = async (req, res) => {
    const { taskId, attachmentId } = ids(req.params);
    const { partNumbers } = parseRequestBody(partUrlsBodySchema, req.body);
    res.set('Cache-Control', 'no-store').json(await service.partUploadUrls(getActor(req), scopeOf(req), taskId, attachmentId, partNumbers));
  };

  const handleComplete: RequestHandler = async (req, res) => {
    const { taskId, attachmentId } = ids(req.params);
    const { parts } = parseRequestBody(completeBodySchema, req.body);
    res.json(await service.completeUpload(getActor(req), scopeOf(req), taskId, attachmentId, parts));
  };

  const handleUrl: RequestHandler = async (req, res) => {
    const { taskId, attachmentId } = ids(req.params);
    const { mode } = parseRequestQuery(urlQuerySchema, req.query);
    res.set('Cache-Control', 'no-store').json(await service.attachmentUrl(getActor(req), scopeOf(req), taskId, attachmentId, mode));
  };

  const handleDelete: RequestHandler = async (req, res) => {
    const { taskId, attachmentId } = ids(req.params);
    const actor = getActor(req);
    await service.deleteAttachment(actor, scopeOf(req), taskId, attachmentId, Boolean(actor.permissions['task.update']));
    res.json({ deleted: true });
  };

  return [
    { method: 'GET', path: '/tasks/tasks/:id/attachments', access: 'private', permission: 'task.read', handler: handleList },
    { method: 'POST', path: '/tasks/tasks/:id/attachments', access: 'private', permission: 'task.read', handler: handleStart },
    { method: 'POST', path: '/tasks/tasks/:id/attachments/:attachmentId/part-urls', access: 'private', permission: 'task.read', handler: handlePartUrls },
    { method: 'POST', path: '/tasks/tasks/:id/attachments/:attachmentId/complete', access: 'private', permission: 'task.read', handler: handleComplete },
    { method: 'GET', path: '/tasks/tasks/:id/attachments/:attachmentId/url', access: 'private', permission: 'task.read', handler: handleUrl },
    { method: 'DELETE', path: '/tasks/tasks/:id/attachments/:attachmentId', access: 'private', permission: 'task.read', handler: handleDelete },
  ];
}
