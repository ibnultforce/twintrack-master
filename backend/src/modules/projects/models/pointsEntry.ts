import { Schema, model } from 'mongoose';

/** Why points moved: approved work, an approved QA pass, or a revert taking some back. */
// approval_reversed takes back what an approval gave when a done task is reverted, so approving it again can't count twice.
export const POINTS_REASONS = ['task_approved', 'qa_approved', 'approval_reversed', 'revert_penalty'] as const;
export type PointsReason = (typeof POINTS_REASONS)[number];

/**
 * One change to a person's career points. Entries are only ever added, never changed, so a person's total and its
 * history always agree, and a revert shows as its own entry rather than a quietly lowered number.
 */
export interface PointsEntryDoc {
  _id: string;
  userId: string;
  taskId: string;
  projectId: string;
  /** Positive for work approved, negative for a revert penalty. */
  points: number;
  reason: PointsReason;
  /** Who approved or reverted the task. */
  createdBy: string;
  createdAt: Date;
}

const pointsEntrySchema = new Schema<PointsEntryDoc>(
  {
    _id: { type: String, required: true },
    userId: { type: String, required: true, index: true },
    taskId: { type: String, required: true, index: true },
    projectId: { type: String, required: true },
    points: { type: Number, required: true },
    reason: { type: String, enum: POINTS_REASONS, required: true },
    createdBy: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

pointsEntrySchema.index({ userId: 1, createdAt: -1 });

export const PointsEntry = model<PointsEntryDoc>('PointsEntry', pointsEntrySchema);
