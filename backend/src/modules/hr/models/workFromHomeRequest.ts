import { Schema, model } from 'mongoose';
import { addRecordFields, type RecordFields } from '../../../lib/records/recordFields.js';

export const WORK_FROM_HOME_STATUSES = ['pending', 'approved', 'not_approved', 'cancelled'] as const;

/** A request to work from home on one day. */
export interface WorkFromHomeRequestDoc extends RecordFields {
  _id: string;
  employeeId: string;
  workDate: Date;
  reason: string;
  status: (typeof WORK_FROM_HOME_STATUSES)[number];
  decidedBy?: string;
  decidedAt?: Date;
  decisionNotes?: string;
}

const workFromHomeRequestSchema = new Schema<WorkFromHomeRequestDoc>(
  {
    _id: { type: String, required: true },
    employeeId: { type: String, required: true },
    workDate: { type: Date, required: true },
    reason: { type: String, required: true },
    status: { type: String, enum: WORK_FROM_HOME_STATUSES, default: 'pending', index: true },
    decidedBy: String,
    decidedAt: Date,
    decisionNotes: String,
  },
  { timestamps: true },
);

workFromHomeRequestSchema.index({ employeeId: 1, workDate: -1 });
addRecordFields(workFromHomeRequestSchema);

export const WorkFromHomeRequest = model<WorkFromHomeRequestDoc>('WorkFromHomeRequest', workFromHomeRequestSchema);
