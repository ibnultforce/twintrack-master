import { TaskAttachment, TaskAttachmentUsage, type TaskAttachmentDoc } from '../models/taskAttachment.js';

const DUPLICATE_KEY = 11000;

/**
 * Claims space for a new file in one atomic update, or returns false when it doesn't fit. A task with no usage record
 * yet gets one. When the record exists but has no room, the filter misses and the upsert's insert hits the existing
 * id, which is how a full task shows itself.
 */
export async function reserveAttachmentBytes(taskId: string, sizeBytes: number, limitBytes: number): Promise<boolean> {
  try {
    await TaskAttachmentUsage.updateOne({ _id: taskId, bytes: { $lte: limitBytes - sizeBytes } }, { $inc: { bytes: sizeBytes } }, { upsert: true });
    return true;
  } catch (error) {
    if ((error as { code?: number }).code === DUPLICATE_KEY) return false;
    throw error;
  }
}

/** Bytes a task's files hold, counting uploads in progress. */
export async function findAttachmentBytes(taskId: string): Promise<number> {
  return (await TaskAttachmentUsage.findById(taskId).lean())?.bytes ?? 0;
}

export async function releaseAttachmentBytes(taskId: string, sizeBytes: number): Promise<void> {
  await TaskAttachmentUsage.updateOne({ _id: taskId }, { $inc: { bytes: -sizeBytes } });
}

export type NewAttachmentRecord = Pick<TaskAttachmentDoc, '_id' | 'taskId' | 'fileName' | 'mimeType' | 'sizeBytes' | 'storageKey' | 'uploadId' | 'uploadedBy'>;

export async function insertAttachment(record: NewAttachmentRecord): Promise<TaskAttachmentDoc> {
  const [created] = await TaskAttachment.create([record]);
  if (!created) throw new Error('Creating the attachment returned nothing.');
  return created.toObject();
}

export const findAttachment = (taskId: string, attachmentId: string) => TaskAttachment.findOne({ _id: attachmentId, taskId }).lean();

export const findReadyAttachments = (taskId: string) => TaskAttachment.find({ taskId, status: 'ready' }).sort({ createdAt: 1, _id: 1 }).lean();

export const findUploadsStartedBefore = (taskId: string, before: Date) => TaskAttachment.find({ taskId, status: 'uploading', createdAt: { $lt: before } }).lean();


/** Marks an upload ready, unless it already was. Returns null for the one that lost a race. */
export const markAttachmentReady = (attachmentId: string) =>
  TaskAttachment.findOneAndUpdate({ _id: attachmentId, status: 'uploading' }, { $set: { status: 'ready', completedAt: new Date() }, $unset: { uploadId: 1 } }, { returnDocument: 'after' }).lean();

/** Removes a file's record and gives its space back. Only the call that removes the record gives it back. */
export async function deleteAttachmentRecord(attachment: Pick<TaskAttachmentDoc, '_id' | 'taskId' | 'sizeBytes'>): Promise<void> {
  const { deletedCount } = await TaskAttachment.deleteOne({ _id: attachment._id });
  if (deletedCount === 1) await releaseAttachmentBytes(attachment.taskId, attachment.sizeBytes);
}
