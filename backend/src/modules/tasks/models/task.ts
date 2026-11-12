import { Schema, model } from 'mongoose';
import { addRecordFields, type RecordFields } from '../../../lib/records/recordFields.js';

/**
 * Where a task is in its life. Being paused is a flag on in_progress and qa_in_progress, not a status of its own,
 * and overdue is a list filter, so status filters stay simple.
 */
export const TASK_STATUSES = ['todo', 'in_progress', 'pending_approval', 'qa_todo', 'qa_in_progress', 'done', 'reverted', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Statuses a task never leaves, apart from a done task being reverted. */
export const CLOSED_TASK_STATUSES: readonly TaskStatus[] = ['done', 'cancelled'];

export const QA_RESULTS = ['pass', 'fail'] as const;
export type QaResult = (typeof QA_RESULTS)[number];

/**
 * What the work is. A QA task is a tester's own work, such as writing test cases: it needs no estimate when its
 * tester adds it for themselves, records pass or fail when it's completed, and is never handed to QA.
 */
export const TASK_KINDS = ['development', 'qa'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export interface TaskDoc extends RecordFields {
  _id: string;
  /** From a counter, never reused. Shown as T-00102. */
  taskNumber: number;
  projectId: string;
  kind: TaskKind;
  title: string;
  description?: string;
  assignedDevId: string;
  tlId: string;
  status: TaskStatus;
  dueDate?: Date;
  estimatedHours: number;
  /** Worked out from the timer when the assignee completes the task. */
  actualHours?: number;
  /** Chosen by the approver. */
  approvedHours?: number;
  /** Career points the work is worth: the estimate until approval, then the approved hours. */
  pointValue: number;
  /** Whether the hours are billed to the client. Internal work, such as meetings or rework, isn't. */
  billable: boolean;
  /** Raised for a follow-up, such as by HR, with a note saying why. Works at any status. */
  flagged: boolean;
  flagNote?: string;
  startedAt?: Date;
  completedAt?: Date;
  approvedBy?: string;
  approvedAt?: Date;
  revertCount: number;
  // The assignee's timer: seconds banked so far, plus the time since resumedAt while it runs.
  paused: boolean;
  resumedAt?: Date;
  accumulatedSeconds: number;
  // The QA timer works the same way.
  qaId?: string;
  qaEstimatedHours?: number;
  qaActualHours?: number;
  qaApprovedHours?: number;
  /** Career points the QA pass is worth, worked out the same way. */
  qaPointValue?: number;
  qaPaused: boolean;
  qaResumedAt?: Date;
  qaAccumulatedSeconds: number;
  qaCompletedAt?: Date;
  qaResult?: QaResult;
  /** Other tasks this one points to. Tasks pointing here are found by querying this field. */
  referencedTaskIds: string[];
  cancelledBy?: string;
  cancelledAt?: Date;
}

const taskSchema = new Schema<TaskDoc>(
  {
    _id: { type: String, required: true },
    taskNumber: { type: Number, required: true, unique: true },
    projectId: { type: String, required: true, index: true },
    kind: { type: String, enum: TASK_KINDS, default: 'development' },
    title: { type: String, required: true },
    description: String,
    assignedDevId: { type: String, required: true, index: true },
    tlId: { type: String, required: true, index: true },
    status: { type: String, enum: TASK_STATUSES, default: 'todo', index: true },
    dueDate: Date,
    estimatedHours: { type: Number, required: true, min: 0 },
    actualHours: Number,
    approvedHours: Number,
    pointValue: { type: Number, default: 0 },
    billable: { type: Boolean, default: true },
    flagged: { type: Boolean, default: false, index: true },
    flagNote: String,
    startedAt: Date,
    completedAt: Date,
    approvedBy: String,
    approvedAt: Date,
    revertCount: { type: Number, default: 0 },
    paused: { type: Boolean, default: false },
    resumedAt: Date,
    accumulatedSeconds: { type: Number, default: 0 },
    qaId: { type: String, index: true },
    qaEstimatedHours: Number,
    qaActualHours: Number,
    qaApprovedHours: Number,
    qaPointValue: Number,
    qaPaused: { type: Boolean, default: false },
    qaResumedAt: Date,
    qaAccumulatedSeconds: { type: Number, default: 0 },
    qaCompletedAt: Date,
    qaResult: { type: String, enum: QA_RESULTS },
    referencedTaskIds: { type: [String], default: [], index: true },
    cancelledBy: String,
    cancelledAt: Date,
  },
  { timestamps: true },
);

addRecordFields(taskSchema);

export const Task = model<TaskDoc>('Task', taskSchema);
