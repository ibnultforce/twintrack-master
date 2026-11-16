import { Schema, model } from 'mongoose';

/**
 * How incentives apply to one person. Nobody earns anything until someone with incentive.update says so, which is how
 * the old app's "team leads and project managers" rule became data instead of code.
 */
export interface IncentiveSettingDoc {
  /** The person's user id: each person has one setting. */
  _id: string;
  /** Earns a monthly incentive on the hours of finished tasks they led. */
  earnsMonthlyIncentive: boolean;
  /** Taka per hour. Missing means the default rate in the API's settings. */
  hourlyRate?: number;
  /** May be given a project incentive on projects they're a member of. */
  eligibleForProjectIncentives: boolean;
  updatedBy: string;
  updatedAt: Date;
}

const incentiveSettingSchema = new Schema<IncentiveSettingDoc>(
  {
    _id: { type: String, required: true },
    earnsMonthlyIncentive: { type: Boolean, default: false, index: true },
    hourlyRate: { type: Number, min: 0 },
    eligibleForProjectIncentives: { type: Boolean, default: false },
    updatedBy: { type: String, required: true },
  },
  { timestamps: { createdAt: false, updatedAt: true } },
);

export const IncentiveSetting = model<IncentiveSettingDoc>('IncentiveSetting', incentiveSettingSchema);

/** An incentive given to one member for their work on one project, set by hand. */
export interface ProjectIncentiveDoc {
  _id: string;
  projectId: string;
  userId: string;
  enabled: boolean;
  /** Taka. Missing when it hasn't been decided yet. */
  amount?: number;
  notes?: string;
  grantedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const projectIncentiveSchema = new Schema<ProjectIncentiveDoc>(
  {
    _id: { type: String, required: true },
    projectId: { type: String, required: true },
    userId: { type: String, required: true, index: true },
    enabled: { type: Boolean, required: true },
    amount: { type: Number, min: 0 },
    notes: String,
    grantedBy: { type: String, required: true },
  },
  { timestamps: true },
);

projectIncentiveSchema.index({ projectId: 1, userId: 1 }, { unique: true });

export const ProjectIncentive = model<ProjectIncentiveDoc>('ProjectIncentive', projectIncentiveSchema);

/**
 * One person's monthly incentive, worked out from the hours they led and their rate. Generating a month again
 * refreshes the figures until it is paid. A paid entry never changes, so it always matches what was paid.
 */
export interface IncentiveLedgerEntryDoc {
  _id: string;
  userId: string;
  month: number;
  year: number;
  completedHours: number;
  hourlyRate: number;
  totalPayout: number;
  disbursed: boolean;
  disbursedAt?: Date;
  disbursedBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

const incentiveLedgerEntrySchema = new Schema<IncentiveLedgerEntryDoc>(
  {
    _id: { type: String, required: true },
    userId: { type: String, required: true },
    month: { type: Number, required: true, min: 1, max: 12 },
    year: { type: Number, required: true },
    completedHours: { type: Number, required: true },
    hourlyRate: { type: Number, required: true },
    totalPayout: { type: Number, required: true },
    disbursed: { type: Boolean, default: false },
    disbursedAt: Date,
    disbursedBy: String,
  },
  { timestamps: true },
);

incentiveLedgerEntrySchema.index({ userId: 1, year: -1, month: -1 }, { unique: true });

export const IncentiveLedgerEntry = model<IncentiveLedgerEntryDoc>('IncentiveLedgerEntry', incentiveLedgerEntrySchema);
