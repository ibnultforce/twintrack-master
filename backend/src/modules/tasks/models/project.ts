import { Schema, model } from 'mongoose';
import { addRecordFields, type RecordFields } from '../../../lib/records/recordFields.js';

export const PROJECT_STATUSES = ['active', 'on_hold', 'completed'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** A body of work led by one person. Tasks in it can only be assigned to its lead or its members. */
export interface ProjectDoc extends RecordFields {
  _id: string;
  name: string;
  description?: string;
  status: ProjectStatus;
  totalAllocatedHours?: number;
  deadline?: Date;
  leadId: string;
  memberIds: string[];
}

const projectSchema = new Schema<ProjectDoc>(
  {
    _id: { type: String, required: true },
    name: { type: String, required: true },
    description: String,
    status: { type: String, enum: PROJECT_STATUSES, default: 'active' },
    totalAllocatedHours: { type: Number, min: 0 },
    deadline: Date,
    leadId: { type: String, required: true, index: true },
    memberIds: { type: [String], default: [], index: true },
  },
  { timestamps: true },
);

addRecordFields(projectSchema);

export const Project = model<ProjectDoc>('Project', projectSchema);
