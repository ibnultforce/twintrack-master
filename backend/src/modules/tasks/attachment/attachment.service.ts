import { randomUUID } from 'node:crypto';
import { ApiError } from '../../../lib/errors.js';
import { UPLOAD_PART_SIZE, type FileStorage } from '../../../lib/storage/fileStorage.js';
import { actorFields, type Actor } from '../../master/access/caller.js';
import { recordAudit } from '../../master/audit/audit.repository.js';
import type { Scope } from '../../master/moduleRegistry/manifest.js';
import type { TaskAttachmentDoc } from '../models/taskAttachment.js';
import { assertCanReachTaskById } from '../task/task.service.js';
import { findPeopleNames, TASKS_MODULE_KEY } from '../tasksModule.js';
import {
  deleteAttachmentRecord,
  findAttachment,
  findReadyAttachments,
  findUploadsStartedBefore,
  insertAttachment,
  markAttachmentReady,
  findAttachmentBytes,
  releaseAttachmentBytes,
  reserveAttachmentBytes,
} from './attachment.repository.js';

/** Every task's files together can take up to 5 GB, so no single file is larger either. */
export const TASK_ATTACHMENT_LIMIT_BYTES = 5 * 1024 ** 3;
/** Uploads left unfinished this long are cleared away, matching R2's rule for unfinished multipart uploads. */
const STALE_UPLOAD_MS = 24 * 60 * 60 * 1000;
/** Shown in the browser. Anything else is downloaded, so a file can't run as a page on the API's address. */
const INLINE_VIEWABLE_TYPES = /^(image\/(png|jpeg|gif|webp|bmp|avif)|video\/(mp4|webm|ogg|quicktime)|audio\/[\w.+-]+|application\/pdf)$/;
/** Shown as plain text, whatever their type, so markup inside them never runs. */
const PLAIN_TEXT_TYPES = /^(text\/(plain|csv|markdown|x-log)|application\/json)$/;

const notFound = () => new ApiError(404, 'unknown_attachment', 'No such file on this task.');

function normalizeMimeType(mimeType: string | undefined): string {
  const value = mimeType?.trim().toLowerCase() ?? '';
  return /^[\w.+-]+\/[\w.+-]+$/.test(value) ? value : 'application/octet-stream';
}

const toAttachmentView = (attachment: TaskAttachmentDoc, names: Map<string, string>) => ({
  id: attachment._id,
  fileName: attachment.fileName,
  mimeType: attachment.mimeType,
  sizeBytes: attachment.sizeBytes,
  status: attachment.status,
  uploadedBy: attachment.uploadedBy,
  uploadedByName: names.get(attachment.uploadedBy),
  createdAt: attachment.createdAt,
});

const attachmentAuditFields = (actor: Actor, attachment: TaskAttachmentDoc) => ({
  ...actorFields(actor),
  targetType: 'taskAttachment',
  targetId: attachment._id,
  targetName: attachment.fileName,
  module: TASKS_MODULE_KEY,
});

/**
 * Files on tasks. Anyone who reaches a task can see and add files, as with comments. An unfinished upload belongs to
 * whoever started it. A finished file can be removed by its uploader, or by someone who can edit the task.
 */
export function createAttachmentService(storage: FileStorage) {
  async function sweepStaleUploads(taskId: string): Promise<void> {
    for (const stale of await findUploadsStartedBefore(taskId, new Date(Date.now() - STALE_UPLOAD_MS))) {
      // The upload may already be gone from storage, and the record goes either way.
      if (stale.uploadId) await storage.abortUpload(stale.storageKey, stale.uploadId).catch(() => undefined);
      await deleteAttachmentRecord(stale);
    }
  }

  async function requireOwnUpload(actor: Actor, taskId: string, attachmentId: string) {
    const attachment = await findAttachment(taskId, attachmentId);
    if (!attachment) throw notFound();
    if (attachment.status !== 'uploading' || !attachment.uploadId) throw new ApiError(409, 'upload_finished', 'This upload has already finished.');
    if (attachment.uploadedBy !== actor.user._id) throw new ApiError(403, 'not_your_upload', 'This upload belongs to someone else.');
    return { ...attachment, uploadId: attachment.uploadId };
  }

  async function listAttachments(actor: Actor, scope: Scope, taskId: string) {
    await assertCanReachTaskById(actor, scope, taskId, 'read');
    await sweepStaleUploads(taskId);
    const attachments = await findReadyAttachments(taskId);
    const names = await findPeopleNames(attachments.map((attachment) => attachment.uploadedBy));
    return {
      attachments: attachments.map((attachment) => toAttachmentView(attachment, names)),
      usedBytes: attachments.reduce((sum, attachment) => sum + attachment.sizeBytes, 0),
      limitBytes: TASK_ATTACHMENT_LIMIT_BYTES,
    };
  }

  /** Reserves the space, starts the upload, and says how to split the file into parts. */
  async function startUpload(actor: Actor, scope: Scope, taskId: string, file: { fileName: string; mimeType?: string; sizeBytes: number }) {
    await assertCanReachTaskById(actor, scope, taskId, 'read');
    await sweepStaleUploads(taskId);
    if (!(await reserveAttachmentBytes(taskId, file.sizeBytes, TASK_ATTACHMENT_LIMIT_BYTES))) {
      const remainingGb = Math.max(0, TASK_ATTACHMENT_LIMIT_BYTES - (await findAttachmentBytes(taskId))) / 1024 ** 3;
      throw new ApiError(413, 'attachment_limit', `A task's files can take 5 GB in all, and ${remainingGb.toFixed(2)} GB is left.`);
    }

    const attachmentId = `ta_${randomUUID()}`;
    const storageKey = `tasks/${taskId}/${attachmentId}`;
    const mimeType = normalizeMimeType(file.mimeType);
    let attachment;
    try {
      const uploadId = await storage.startUpload(storageKey, mimeType);
      attachment = await insertAttachment({
        _id: attachmentId,
        taskId,
        fileName: file.fileName,
        mimeType,
        sizeBytes: file.sizeBytes,
        storageKey,
        uploadId,
        uploadedBy: actor.user._id,
      });
    } catch (error) {
      // The space was claimed for a file that never got a record, so it goes back.
      await releaseAttachmentBytes(taskId, file.sizeBytes);
      throw error;
    }
    return {
      attachment: toAttachmentView(attachment, await findPeopleNames([actor.user._id])),
      partSize: UPLOAD_PART_SIZE,
      partCount: Math.ceil(file.sizeBytes / UPLOAD_PART_SIZE),
    };
  }

  async function partUploadUrls(actor: Actor, scope: Scope, taskId: string, attachmentId: string, partNumbers: number[]) {
    await assertCanReachTaskById(actor, scope, taskId, 'read');
    const upload = await requireOwnUpload(actor, taskId, attachmentId);
    const partCount = Math.ceil(upload.sizeBytes / UPLOAD_PART_SIZE);
    if (partNumbers.some((partNumber) => partNumber > partCount)) {
      throw new ApiError(422, 'validation_failed', 'Some fields are invalid.', [{ path: 'partNumbers', message: `this file has ${partCount} part(s)` }]);
    }
    return { parts: await storage.partUploadUrls(upload.storageKey, upload.uploadId, partNumbers) };
  }

  /** Joins the parts, then checks the stored size matches what was declared, so the limit can't be dodged. */
  async function completeUpload(actor: Actor, scope: Scope, taskId: string, attachmentId: string, parts: { partNumber: number; etag: string }[]) {
    await assertCanReachTaskById(actor, scope, taskId, 'read');
    const upload = await requireOwnUpload(actor, taskId, attachmentId);
    await storage.completeUpload(upload.storageKey, upload.uploadId, [...parts].sort((first, second) => first.partNumber - second.partNumber));

    if ((await storage.objectSize(upload.storageKey)) !== upload.sizeBytes) {
      await storage.deleteObject(upload.storageKey).catch(() => undefined);
      await deleteAttachmentRecord(upload);
      throw new ApiError(422, 'size_mismatch', "The uploaded file doesn't match its declared size. Try again.");
    }
    const ready = await markAttachmentReady(attachmentId);
    if (!ready) throw new ApiError(409, 'upload_finished', 'This upload has already finished.');
    await recordAudit({ action: 'task.attachment_added', ...attachmentAuditFields(actor, ready) });
    return toAttachmentView(ready, await findPeopleNames([ready.uploadedBy]));
  }

  /** A short-lived address that shows the file, or saves it. Types a browser can't show safely always download. */
  async function attachmentUrl(actor: Actor, scope: Scope, taskId: string, attachmentId: string, mode: 'view' | 'download') {
    await assertCanReachTaskById(actor, scope, taskId, 'read');
    const attachment = await findAttachment(taskId, attachmentId);
    if (attachment?.status !== 'ready') throw notFound();

    const isViewable = INLINE_VIEWABLE_TYPES.test(attachment.mimeType);
    const isPlainText = PLAIN_TEXT_TYPES.test(attachment.mimeType);
    const contentType = isPlainText ? 'text/plain; charset=utf-8' : isViewable ? attachment.mimeType : 'application/octet-stream';
    const disposition = mode === 'view' && (isViewable || isPlainText) ? 'inline' : 'attachment';
    return { url: await storage.downloadUrl(attachment.storageKey, { fileName: attachment.fileName, contentType, disposition }) };
  }

  async function deleteAttachment(actor: Actor, scope: Scope, taskId: string, attachmentId: string, canEditTask: boolean) {
    const attachment = await findAttachment(taskId, attachmentId);
    if (!attachment) throw notFound();
    const isOwn = attachment.uploadedBy === actor.user._id;

    if (attachment.status === 'uploading') {
      if (!isOwn) throw new ApiError(403, 'not_your_upload', 'This upload belongs to someone else.');
      if (attachment.uploadId) await storage.abortUpload(attachment.storageKey, attachment.uploadId).catch(() => undefined);
      await deleteAttachmentRecord(attachment);
      return;
    }

    await assertCanReachTaskById(actor, scope, taskId, isOwn ? 'read' : 'edit');
    if (!isOwn && !canEditTask) throw new ApiError(403, 'forbidden', 'Only whoever added this file, or someone who can edit the task, can remove it.');
    await storage.deleteObject(attachment.storageKey);
    await deleteAttachmentRecord(attachment);
    await recordAudit({ action: 'task.attachment_removed', ...attachmentAuditFields(actor, attachment) });
  }

  return { listAttachments, startUpload, partUploadUrls, completeUpload, attachmentUrl, deleteAttachment };
}
