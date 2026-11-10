import { Schema, model } from 'mongoose';
import { addRecordFields, type RecordFields } from '../../../lib/records/recordFields.js';

/** One record of an object an admin defined in the app. Its fields are checked against the definition on every write. */
export interface CustomRecordDoc extends RecordFields {
  _id: string;
  module: string;
  object: string;
  /** Whoever created it. Their place in the org tree decides whose scope reaches it. */
  ownerId: string;
  values: Record<string, unknown>;
}

const customRecordSchema = new Schema<CustomRecordDoc>(
  {
    _id: { type: String, required: true },
    module: { type: String, required: true },
    object: { type: String, required: true },
    ownerId: { type: String, required: true, index: true },
    values: { type: Schema.Types.Mixed, default: {} },
  },
  { collection: 'custom_records', timestamps: true, minimize: false },
);

customRecordSchema.index({ module: 1, object: 1, createdAt: -1 });
addRecordFields(customRecordSchema);

export const CustomRecord = model<CustomRecordDoc>('CustomRecord', customRecordSchema);
