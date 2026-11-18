import { Schema, model } from 'mongoose';
import type { ModuleChangeItem } from '../moduleRegistry/moduleChanges.js';

export type ModuleChangeSource = 'manifest' | 'schema';

/**
 * What one manifest or schema import changed in a module, and where the code and docs need work to match it.
 * Pending until a developer marks it done.
 */
export interface ModuleChangeDoc {
  _id: string;
  module: string;
  moduleName: string;
  source: ModuleChangeSource;
  versionBefore: string | null;
  versionAfter: string;
  items: ModuleChangeItem[];
  changedAt: Date;
  changedBy?: string;
  changedByName?: string;
  doneAt?: Date;
  doneBy?: string;
  doneByName?: string;
}

const moduleChangeSchema = new Schema<ModuleChangeDoc>(
  {
    _id: { type: String, required: true },
    module: { type: String, required: true },
    moduleName: { type: String, required: true },
    source: { type: String, enum: ['manifest', 'schema'], required: true },
    versionBefore: { type: String, default: null },
    versionAfter: { type: String, required: true },
    items: { type: Schema.Types.Mixed, default: [] },
    changedAt: { type: Date, required: true },
    changedBy: String,
    changedByName: String,
    doneAt: Date,
    doneBy: String,
    doneByName: String,
  },
  { versionKey: false },
);

moduleChangeSchema.index({ module: 1, changedAt: -1 });

export const ModuleChange = model<ModuleChangeDoc>('ModuleChange', moduleChangeSchema, 'module_changes');
