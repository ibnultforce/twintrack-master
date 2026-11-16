import { Schema, model } from 'mongoose';
import { addRecordFields, type RecordFields } from '../../../lib/records/recordFields.js';

/** Routine reviews come round on a cycle; merit reviews are raised for good work. */
export const REVIEW_TRIGGERS = ['routine', 'merit'] as const;

/** Pending until reviewed, then completed once any salary change it decided has been made. */
export const REVIEW_STATUSES = ['pending', 'reviewed', 'completed'] as const;

/** A performance review, and the salary change it led to. */
export interface ReviewDoc extends RecordFields {
  _id: string;
  employeeId: string;
  reviewDate: Date;
  trigger: (typeof REVIEW_TRIGGERS)[number];
  status: (typeof REVIEW_STATUSES)[number];
  notes?: string;
  currency?: string;
  incrementAmount?: number;
  newSalaryAmount?: number;
  reviewedBy?: string;
  reviewedAt?: Date;
  /** The Salary record the review's change was made in. */
  salaryId?: string;
  salaryUpdatedBy?: string;
  salaryUpdatedAt?: Date;
}

const reviewSchema = new Schema<ReviewDoc>(
  {
    _id: { type: String, required: true },
    employeeId: { type: String, required: true },
    reviewDate: { type: Date, required: true },
    trigger: { type: String, enum: REVIEW_TRIGGERS, default: 'routine' },
    status: { type: String, enum: REVIEW_STATUSES, default: 'pending', index: true },
    notes: String,
    currency: String,
    incrementAmount: { type: Number, min: 0 },
    newSalaryAmount: { type: Number, min: 0 },
    reviewedBy: String,
    reviewedAt: Date,
    salaryId: String,
    salaryUpdatedBy: String,
    salaryUpdatedAt: Date,
  },
  { timestamps: true },
);

reviewSchema.index({ employeeId: 1, reviewDate: -1 });
addRecordFields(reviewSchema);

export const Review = model<ReviewDoc>('Review', reviewSchema);
