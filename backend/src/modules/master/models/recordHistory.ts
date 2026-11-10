import { Schema, model } from 'mongoose';

export const HISTORY_ACTIONS = ['created', 'updated', 'deleted', 'restored'] as const;

/** One change to a tracked field. Values are stored as JSON-ready values, so dates are ISO strings. */
export interface FieldChange {
  field: string;
  from?: unknown;
  to?: unknown;
}

/**
 * One event in a business record's life, written in the same transaction as the change itself. Unlike the activity log,
 * it holds field values, so it's shown only to people who can read the record.
 */
export interface RecordHistoryDoc {
  at: Date;
  module: string;
  /** The manifest resource the record belongs to, such as salary. */
  object: string;
  recordId: string;
  action: (typeof HISTORY_ACTIONS)[number];
  changes: FieldChange[];
  actorId: string;
  actorName: string;
}

const recordHistorySchema = new Schema<RecordHistoryDoc>(
  {
    at: { type: Date, required: true, default: Date.now },
    module: { type: String, required: true },
    object: { type: String, required: true },
    recordId: { type: String, required: true },
    action: { type: String, enum: HISTORY_ACTIONS, required: true },
    changes: { type: Schema.Types.Mixed, default: [] },
    actorId: { type: String, required: true },
    actorName: { type: String, required: true },
  },
  { collection: 'record_history' },
);

recordHistorySchema.index({ module: 1, object: 1, recordId: 1, at: -1 });

export const RecordHistory = model<RecordHistoryDoc>('RecordHistory', recordHistorySchema);
