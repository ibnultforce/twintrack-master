import { Schema, model } from 'mongoose';

export const GRANTEE_TYPES = ['user', 'orgRole', 'orgRoleAndBelow'] as const;
export const SHARE_ACCESS = ['read', 'edit'] as const;

export type GranteeType = (typeof GRANTEE_TYPES)[number];
export type ShareAccess = (typeof SHARE_ACCESS)[number];

/**
 * Gives access to one business record beyond what the person's scope reaches. It never adds a permission: the
 * person still needs, say, salary.read. It only lets that permission reach this record.
 */
export interface RecordShareDoc {
  _id: string;
  module: string;
  object: string;
  recordId: string;
  /** One person, the people in one org role, or the people in an org role and every role below it. */
  granteeType: GranteeType;
  granteeId: string;
  access: ShareAccess;
  /** The share stops counting after this. Missing means it lasts until someone removes it. */
  expiresAt?: Date;
  sharedBy: string;
  createdAt: Date;
}

const recordShareSchema = new Schema<RecordShareDoc>(
  {
    _id: { type: String, required: true },
    module: { type: String, required: true },
    object: { type: String, required: true },
    recordId: { type: String, required: true },
    granteeType: { type: String, enum: GRANTEE_TYPES, required: true },
    granteeId: { type: String, required: true },
    access: { type: String, enum: SHARE_ACCESS, required: true },
    expiresAt: Date,
    sharedBy: { type: String, required: true },
  },
  { collection: 'record_shares', timestamps: { createdAt: true, updatedAt: false } },
);

recordShareSchema.index({ module: 1, object: 1, recordId: 1 });
recordShareSchema.index({ module: 1, object: 1, granteeType: 1, granteeId: 1 });
// One share per record and grantee, so sharing again changes the access instead of stacking.
recordShareSchema.index({ module: 1, object: 1, recordId: 1, granteeType: 1, granteeId: 1 }, { unique: true });

export const RecordShare = model<RecordShareDoc>('RecordShare', recordShareSchema);
