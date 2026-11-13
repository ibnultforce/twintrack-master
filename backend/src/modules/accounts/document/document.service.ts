import { randomUUID } from 'node:crypto';
import { ApiError } from '../../../lib/errors.js';
import { UPLOAD_PART_SIZE, type FileStorage } from '../../../lib/storage/fileStorage.js';
import { normalizeMimeType, safeDownload } from '../../../lib/storage/fileTypes.js';
import type { Actor } from '../../master/access/caller.js';
import { actorFields } from '../../master/access/caller.js';
import { recordAudit } from '../../master/audit/audit.repository.js';
import { ACCOUNTS_MODULE_KEY, findPeopleNames } from '../accountsModule.js';
import { AccountsDocument, type AccountsDocumentDoc, type DocumentOwnerType } from '../models/accountsDocument.js';
import { Bill, Payment, Receipt } from '../models/money.js';
import { PayrollRun } from '../models/payroll.js';

/** One piece of evidence, such as a scanned bill or a bank slip, is at most this big. */
export const DOCUMENT_LIMIT_BYTES = 100 * 1024 * 1024;
/** Uploads left unfinished this long are cleared away, as for task files. */
const STALE_UPLOAD_MS = 24 * 60 * 60 * 1000;

/** The permission whose record a document belongs to. Reading or changing a document needs that record's read. */
const OWNER_RESOURCE: Record<DocumentOwnerType, string> = { bill: 'bill', payment: 'payment', receipt: 'receipt', payrollItem: 'payrollRun' };

const notFound = () => new ApiError(404, 'unknown_document', 'No such document.');

export interface DocumentOwner {
  ownerType: DocumentOwnerType;
  ownerId: string;
}

const toView = (document: AccountsDocumentDoc, names: Map<string, string>) => ({
  id: document._id,
  ownerType: document.ownerType,
  ownerId: document.ownerId,
  runId: document.runId,
  fileName: document.fileName,
  mimeType: document.mimeType,
  sizeBytes: document.sizeBytes,
  status: document.status,
  uploadedBy: document.uploadedBy,
  uploadedByName: names.get(document.uploadedBy),
  createdAt: document.createdAt,
});

const auditFields = (actor: Actor, document: AccountsDocumentDoc) => ({
  ...actorFields(actor),
  targetType: 'document',
  targetId: document._id,
  targetName: document.fileName,
  module: ACCOUNTS_MODULE_KEY,
});

/**
 * Evidence on bills, payments, receipts and payroll items. A document is reached through its record, so the caller
 * needs read on that record's resource as well as the document permission. An unfinished upload belongs to whoever
 * started it.
 */
export function createDocumentService(storage: FileStorage) {
  /** Checks the record exists and the caller may read it. Returns the run a payroll item is in. */
  async function requireOwner(actor: Actor, owner: DocumentOwner): Promise<{ runId?: string }> {
    const resource = OWNER_RESOURCE[owner.ownerType];
    if (!actor.permissions[`${resource}.read`]) throw new ApiError(403, 'forbidden', `Documents on this record need ${resource}.read as well.`);
    const missing = new ApiError(422, 'validation_failed', 'Some fields are invalid.', [{ path: 'ownerId', message: `no such ${owner.ownerType}` }]);
    if (owner.ownerType === 'payrollItem') {
      const run = await PayrollRun.findOne({ 'items._id': owner.ownerId }).select('_id').lean();
      if (!run) throw missing;
      return { runId: run._id };
    }
    const model = { bill: Bill, payment: Payment, receipt: Receipt }[owner.ownerType];
    if (!(await (model as typeof Bill).exists({ _id: owner.ownerId }))) throw missing;
    return {};
  }

  async function requireDocument(actor: Actor, documentId: string): Promise<AccountsDocumentDoc> {
    const document = await AccountsDocument.findById(documentId).lean();
    if (!document) throw notFound();
    await requireOwner(actor, document);
    return document;
  }

  async function requireOwnUpload(actor: Actor, documentId: string) {
    const document = await requireDocument(actor, documentId);
    if (document.status !== 'uploading' || !document.uploadId) throw new ApiError(409, 'upload_finished', 'This upload has already finished.');
    if (document.uploadedBy !== actor.user._id) throw new ApiError(403, 'not_your_upload', 'This upload belongs to someone else.');
    return { ...document, uploadId: document.uploadId };
  }

  async function sweepStaleUploads(owner: DocumentOwner): Promise<void> {
    const stale = await AccountsDocument.find({ ...owner, status: 'uploading', createdAt: { $lt: new Date(Date.now() - STALE_UPLOAD_MS) } }).lean();
    for (const document of stale) {
      // The upload may already be gone from storage, and the record goes either way.
      if (document.uploadId) await storage.abortUpload(document.storageKey, document.uploadId).catch(() => undefined);
      await AccountsDocument.deleteOne({ _id: document._id });
    }
  }

  async function listDocuments(actor: Actor, owner: DocumentOwner) {
    await requireOwner(actor, owner);
    await sweepStaleUploads(owner);
    const documents = await AccountsDocument.find({ ...owner, status: 'ready' }).sort({ createdAt: 1, _id: 1 }).lean();
    const names = await findPeopleNames(documents.map((document) => document.uploadedBy));
    return { documents: documents.map((document) => toView(document, names)) };
  }

  /** Starts an upload and says how to split the file into parts. */
  async function startUpload(actor: Actor, request: DocumentOwner & { fileName: string; mimeType?: string; sizeBytes: number }) {
    const { runId } = await requireOwner(actor, request);
    await sweepStaleUploads(request);
    const documentId = `doc_${randomUUID()}`;
    const storageKey = `accounts/${request.ownerType}/${request.ownerId}/${documentId}`;
    const mimeType = normalizeMimeType(request.mimeType);
    const uploadId = await storage.startUpload(storageKey, mimeType);
    const [created] = await AccountsDocument.create([
      { _id: documentId, ownerType: request.ownerType, ownerId: request.ownerId, ...(runId && { runId }), fileName: request.fileName, mimeType, sizeBytes: request.sizeBytes, storageKey, uploadId, uploadedBy: actor.user._id },
    ]);
    const document = created!.toObject();
    return { document: toView(document, await findPeopleNames([actor.user._id])), partSize: UPLOAD_PART_SIZE, partCount: Math.ceil(request.sizeBytes / UPLOAD_PART_SIZE) };
  }

  async function partUploadUrls(actor: Actor, documentId: string, partNumbers: number[]) {
    const upload = await requireOwnUpload(actor, documentId);
    const partCount = Math.ceil(upload.sizeBytes / UPLOAD_PART_SIZE);
    if (partNumbers.some((partNumber) => partNumber > partCount)) {
      throw new ApiError(422, 'validation_failed', 'Some fields are invalid.', [{ path: 'partNumbers', message: `this file has ${partCount} part(s)` }]);
    }
    return { parts: await storage.partUploadUrls(upload.storageKey, upload.uploadId, partNumbers) };
  }

  /** Joins the parts, then checks the stored size matches what was declared. */
  async function completeUpload(actor: Actor, documentId: string, parts: { partNumber: number; etag: string }[]) {
    const upload = await requireOwnUpload(actor, documentId);
    await storage.completeUpload(upload.storageKey, upload.uploadId, [...parts].sort((first, second) => first.partNumber - second.partNumber));
    if ((await storage.objectSize(upload.storageKey)) !== upload.sizeBytes) {
      await storage.deleteObject(upload.storageKey).catch(() => undefined);
      await AccountsDocument.deleteOne({ _id: documentId });
      throw new ApiError(422, 'size_mismatch', "The uploaded file doesn't match its declared size. Try again.");
    }
    const ready = await AccountsDocument.findOneAndUpdate({ _id: documentId, status: 'uploading' }, { $set: { status: 'ready' }, $unset: { uploadId: 1 } }, { returnDocument: 'after' }).lean();
    if (!ready) throw new ApiError(409, 'upload_finished', 'This upload has already finished.');
    await recordAudit({ action: 'document.added', ...auditFields(actor, ready) });
    return toView(ready, await findPeopleNames([ready.uploadedBy]));
  }

  async function documentUrl(actor: Actor, documentId: string, mode: 'view' | 'download') {
    const document = await requireDocument(actor, documentId);
    if (document.status !== 'ready') throw notFound();
    return { url: await storage.downloadUrl(document.storageKey, safeDownload(document, mode)) };
  }

  /** Evidence is removed by whoever added it, or by someone with document.delete. An unfinished upload only by its uploader. */
  async function deleteDocument(actor: Actor, documentId: string): Promise<void> {
    const document = await requireDocument(actor, documentId);
    const isOwn = document.uploadedBy === actor.user._id;
    if (document.status === 'uploading') {
      if (!isOwn) throw new ApiError(403, 'not_your_upload', 'This upload belongs to someone else.');
      if (document.uploadId) await storage.abortUpload(document.storageKey, document.uploadId).catch(() => undefined);
    } else {
      if (!isOwn && !actor.permissions['document.delete']) throw new ApiError(403, 'forbidden', 'Removing evidence someone else added needs document.delete.');
      await storage.deleteObject(document.storageKey);
      await recordAudit({ action: 'document.removed', ...auditFields(actor, document) });
    }
    await AccountsDocument.deleteOne({ _id: documentId });
  }

  return { listDocuments, startUpload, partUploadUrls, completeUpload, documentUrl, deleteDocument };
}
