import { Schema, model } from 'mongoose';
import type { Grants } from '../moduleRegistry/manifest.js';

/**
 * An org-wide access profile. Each person holds at most one, and it is where all of their permissions in every module
 * come from. Creating profiles needs accessProfile.create, and giving them needs userProfile.update.
 */
export interface AccessProfileDoc {
  _id: string;
  name: string;
  description?: string;
  /** Module key to that module's grants. A module that isn't listed gives nothing. */
  grants: Record<string, Grants>;
  createdAt: Date;
  updatedAt: Date;
}

const accessProfileSchema = new Schema<AccessProfileDoc>(
  {
    _id: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    description: String,
    grants: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, minimize: false },
);

export const AccessProfile = model<AccessProfileDoc>('AccessProfile', accessProfileSchema);
