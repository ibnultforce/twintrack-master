import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import type { FileStorage } from '../../../lib/storage/fileStorage.js';
import { parseRequestBody, parseRequestQuery } from '../../../lib/validation.js';
import { getActor } from '../../master/access/caller.js';
import { idField } from '../accountsFields.js';
import { DOCUMENT_OWNER_TYPES } from '../models/accountsDocument.js';
import { createDocumentService, DOCUMENT_LIMIT_BYTES } from './document.service.js';

const MAX_PART_NUMBER = 10_000;
const MAX_PARTS_PER_REQUEST = 100;

const ownerFields = { ownerType: z.enum(DOCUMENT_OWNER_TYPES), ownerId: idField };
const listQuerySchema = z.object(ownerFields);
const startBodySchema = z.strictObject({
  ...ownerFields,
  fileName: z.string().trim().min(1, 'is required').max(255),
  mimeType: z.string().max(255).optional(),
  sizeBytes: z.number().int().positive().max(DOCUMENT_LIMIT_BYTES, 'must be 100 MB or less'),
});
const partNumberField = z.number().int().min(1).max(MAX_PART_NUMBER);
const partUrlsBodySchema = z.strictObject({ partNumbers: z.array(partNumberField).min(1).max(MAX_PARTS_PER_REQUEST) });
const completeBodySchema = z.strictObject({ parts: z.array(z.strictObject({ partNumber: partNumberField, etag: z.string().min(1).max(200) })).min(1).max(MAX_PART_NUMBER) });
const urlQuerySchema = z.object({ mode: z.enum(['view', 'download']).default('view') });

/**
 * Evidence on bills, payments, receipts and payroll items, uploaded straight to storage in parts. Each route also needs
 * read on the record the document belongs to, which the service checks.
 */
export function createDocumentRoutes(storage: FileStorage): ApiRoute[] {
  const service = createDocumentService(storage);
  const id = (params: Record<string, unknown>) => String(params.id);

  const handleList: RequestHandler = async (req, res) => {
    res.json(await service.listDocuments(getActor(req), parseRequestQuery(listQuerySchema, req.query)));
  };
  const handleStart: RequestHandler = async (req, res) => {
    res.status(201).json(await service.startUpload(getActor(req), parseRequestBody(startBodySchema, req.body)));
  };
  const handlePartUrls: RequestHandler = async (req, res) => {
    res.json(await service.partUploadUrls(getActor(req), id(req.params), parseRequestBody(partUrlsBodySchema, req.body).partNumbers));
  };
  const handleComplete: RequestHandler = async (req, res) => {
    res.json(await service.completeUpload(getActor(req), id(req.params), parseRequestBody(completeBodySchema, req.body).parts));
  };
  const handleUrl: RequestHandler = async (req, res) => {
    res.json(await service.documentUrl(getActor(req), id(req.params), parseRequestQuery(urlQuerySchema, req.query).mode));
  };
  const handleDelete: RequestHandler = async (req, res) => {
    await service.deleteDocument(getActor(req), id(req.params));
    res.status(204).end();
  };

  return [
    { method: 'GET', path: '/accounts/documents', access: 'private', permission: 'document.read', handler: handleList },
    { method: 'POST', path: '/accounts/documents', access: 'private', permission: 'document.create', handler: handleStart },
    { method: 'POST', path: '/accounts/documents/:id/part-urls', access: 'private', permission: 'document.create', handler: handlePartUrls },
    { method: 'POST', path: '/accounts/documents/:id/complete', access: 'private', permission: 'document.create', handler: handleComplete },
    { method: 'GET', path: '/accounts/documents/:id/url', access: 'private', permission: 'document.read', handler: handleUrl },
    // Removing your own needs only document.create. Someone else's also needs document.delete, checked in the service.
    { method: 'DELETE', path: '/accounts/documents/:id', access: 'private', permission: 'document.create', handler: handleDelete },
  ];
}
