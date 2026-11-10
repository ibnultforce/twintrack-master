import { Schema, model } from 'mongoose';
import type { Grants } from '../moduleRegistry/manifest.js';

/**
 * An org-wide access profile. Each person has one, and it sets their baseline permissions in every module.
 * Permission sets add to it, and the widest scope wins. Only Master admins create profiles and give them to people.
 */
export interface AccessProfileDoc {
  _id: string;
  name: string;
  description?: string;
  /** Module key to that module's grants, in the same form as a permission set. A module that isn't listed gives nothing. */
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
