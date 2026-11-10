import { Schema, model } from 'mongoose';

/**
 * A position in the organisation tree. Every role has one parent except the single root, and a person in a role
 * sees records owned by people in the roles below it. The tree decides visibility only, never permissions.
 */
export interface OrgRoleDoc {
  _id: string;
  name: string;
  description?: string;
  /** Missing only on the root. */
  parentId?: string;
  /** Every role above this one, root first, so one indexed query finds a whole subtree. */
  ancestorIds: string[];
  /** Set only on the root. A unique index on it means the tree can never have two roots. */
  isRoot?: true;
  createdAt: Date;
  updatedAt: Date;
}

const orgRoleSchema = new Schema<OrgRoleDoc>(
  {
    _id: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    description: String,
    parentId: { type: String, index: true },
    ancestorIds: { type: [String], default: [], index: true },
    isRoot: Boolean,
  },
  { timestamps: true },
);

orgRoleSchema.index({ isRoot: 1 }, { unique: true, partialFilterExpression: { isRoot: true } });

export const OrgRole = model<OrgRoleDoc>('OrgRole', orgRoleSchema);
