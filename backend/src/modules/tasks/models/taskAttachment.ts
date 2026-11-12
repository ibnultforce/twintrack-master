import { Schema, model } from 'mongoose';

export const ATTACHMENT_STATUSES = ['uploading', 'ready'] as const;
export type AttachmentStatus = (typeof ATTACHMENT_STATUSES)[number];

/**
 * A file on a task, of any type. The bytes are in file storage (R2, or the local disk in development). This holds
 * what the app needs to find, show and limit them. An upload counts against the task's limit from the moment it
 * starts, through TaskAttachmentUsage, so two people can't both use the last of the space.
 */
export interface TaskAttachmentDoc {
  _id: string;
  taskId: string;
  /** As uploaded, for showing only. The storage key never contains it. */
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  /** tasks/<taskId>/<attachmentId> */
  storageKey: string;
  status: AttachmentStatus;
  /** The storage's id for an upload in progress, removed once it's ready. */
  uploadId?: string;
  uploadedBy: string;
  createdAt: Date;
  completedAt?: Date;
}

const taskAttachmentSchema = new Schema<TaskAttachmentDoc>(
  {
    _id: { type: String, required: true },
    taskId: { type: String, required: true, index: true },
    fileName: { type: String, required: true },
    mimeType: { type: String, required: true },
    sizeBytes: { type: Number, required: true, min: 1 },
    storageKey: { type: String, required: true, unique: true },
    status: { type: String, enum: ATTACHMENT_STATUSES, default: 'uploading' },
    uploadId: String,
    uploadedBy: { type: String, required: true },
    completedAt: Date,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export const TaskAttachment = model<TaskAttachmentDoc>('TaskAttachment', taskAttachmentSchema);

/**
 * Bytes each task's files hold, kept beside the files so a new upload can claim space in one atomic update. Summing
 * the files and then adding one would let two uploads at once both take the last of the space.
 */
export interface TaskAttachmentUsageDoc {
  /** The task's id. */
  _id: string;
  bytes: number;
}

const taskAttachmentUsageSchema = new Schema<TaskAttachmentUsageDoc>({ _id: { type: String, required: true }, bytes: { type: Number, required: true, min: 0 } });

export const TaskAttachmentUsage = model<TaskAttachmentUsageDoc>('TaskAttachmentUsage', taskAttachmentUsageSchema, 'task_attachment_usage');
