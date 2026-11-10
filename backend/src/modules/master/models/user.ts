import { Schema, model } from 'mongoose';

export const CONTRACTS = ['permanent', 'intern', 'contractor'] as const;
export const USER_STATUSES = ['active', 'inactive'] as const;

export interface UserDoc {
  _id: string;
  name: string;
  email: string;
  passwordHash: string;
  mustChangePassword: boolean;
  title?: string;
  department?: string;
  team?: string;
  contract: (typeof CONTRACTS)[number];
  status: (typeof USER_STATUSES)[number];
  managerId?: string;
  /** The person's place in the organisation tree, which decides whose records they see. */
  orgRoleId?: string;
  superAdmin: boolean;
  /** The person's one access profile, which sets their baseline permissions across every module. */
  profileId?: string;
  /** Module key to the keys of permission sets given on top of the profile, for example { hr: ['salary-approver'] }. */
  permissionSets: Record<string, string[]>;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<UserDoc>(
  {
    _id: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    mustChangePassword: { type: Boolean, default: false },
    title: String,
    department: String,
    team: String,
    contract: { type: String, enum: CONTRACTS, default: 'permanent' },
    status: { type: String, enum: USER_STATUSES, default: 'active' },
    managerId: { type: String, index: true },
    orgRoleId: { type: String, index: true },
    superAdmin: { type: Boolean, default: false },
    profileId: { type: String, index: true },
    permissionSets: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, minimize: false },
);

export const User = model<UserDoc>('User', userSchema);
