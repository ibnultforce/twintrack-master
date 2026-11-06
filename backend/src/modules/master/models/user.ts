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
  superAdmin: boolean;
  /** Module key to role key, for example { hr: 'manager' }. */
  assignments: Record<string, string>;
  /** Module key to extra permissions, for example { hr: ['salary.read'] }. */
  privileges: Record<string, string[]>;
  /** Module key to permissions only a super admin can give, because the module doesn't mark them grantable. */
  superAdminGrants?: Record<string, string[]>;
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
    superAdmin: { type: Boolean, default: false },
    assignments: { type: Schema.Types.Mixed, default: {} },
    privileges: { type: Schema.Types.Mixed, default: {} },
    superAdminGrants: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, minimize: false },
);

export const User = model<UserDoc>('User', userSchema);
