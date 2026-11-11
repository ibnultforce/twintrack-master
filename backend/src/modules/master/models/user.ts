import { Schema, model } from 'mongoose';

export const CONTRACTS = ['permanent', 'intern', 'contractor'] as const;
export const USER_STATUSES = ['active', 'inactive'] as const;

export interface UserDoc {
  _id: string;
  name: string;
  email: string;
  passwordHash: string;
  title?: string;
  department?: string;
  team?: string;
  contract: (typeof CONTRACTS)[number];
  status: (typeof USER_STATUSES)[number];
  managerId?: string;
  /** The person's place in the organisation tree, which decides whose records they see. */
  orgRoleId?: string;
  superAdmin: boolean;
  /** The person's one access profile, which is where all of their permissions in every module come from. */
  profileId?: string;
  /** A short number HR and payroll use to refer to someone. Handed out in order when a person is added. */
  employeeNumber?: number;
  /** When the profile photo last changed. Missing means there's no photo. */
  photoUpdatedAt?: Date;
  /** Missing means the person has never signed in, so their account is still waiting to be set up. */
  lastSignedInAt?: Date;
  /** The last time an open app said the person was there, which decides whether they show as online. */
  lastSeenAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<UserDoc>(
  {
    _id: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    title: String,
    department: String,
    team: String,
    contract: { type: String, enum: CONTRACTS, default: 'permanent' },
    status: { type: String, enum: USER_STATUSES, default: 'active' },
    managerId: { type: String, index: true },
    orgRoleId: { type: String, index: true },
    superAdmin: { type: Boolean, default: false },
    profileId: { type: String, index: true },
    employeeNumber: { type: Number, min: 1, unique: true, sparse: true },
    photoUpdatedAt: Date,
    lastSignedInAt: Date,
    lastSeenAt: Date,
  },
  { timestamps: true, minimize: false },
);

export const User = model<UserDoc>('User', userSchema);
