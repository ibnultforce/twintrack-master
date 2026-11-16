import { Schema, model } from 'mongoose';
import { addRecordFields, type RecordFields } from '../../../lib/records/recordFields.js';

/** Casual leave is granted per year. Awarded leave is earned, such as for extra work, and carries over. */
export const LEAVE_TYPES = ['casual', 'awarded'] as const;
export type LeaveType = (typeof LEAVE_TYPES)[number];

/**
 * How much leave of one type someone has. Casual has one balance per year; awarded has a single running balance,
 * with no year. Available days are entitlement + adjustment - taken.
 */
export interface LeaveBalanceDoc extends RecordFields {
  _id: string;
  employeeId: string;
  leaveType: LeaveType;
  /** Set for casual leave only. */
  year?: number;
  entitlementDays: number;
  takenDays: number;
  /** HR's correction, up or down, with a note saying why. */
  adjustmentDays: number;
  adjustmentNotes?: string;
  adjustedBy?: string;
  adjustedAt?: Date;
}

const leaveBalanceSchema = new Schema<LeaveBalanceDoc>(
  {
    _id: { type: String, required: true },
    employeeId: { type: String, required: true },
    leaveType: { type: String, enum: LEAVE_TYPES, required: true },
    year: { type: Number, min: 2000, max: 2200 },
    entitlementDays: { type: Number, default: 0, min: 0 },
    takenDays: { type: Number, default: 0, min: 0 },
    adjustmentDays: { type: Number, default: 0 },
    adjustmentNotes: String,
    adjustedBy: String,
    adjustedAt: Date,
  },
  { timestamps: true },
);

// A missing year is indexed as null, so awarded leave also gets only one balance per person.
leaveBalanceSchema.index({ employeeId: 1, leaveType: 1, year: 1 }, { unique: true });
addRecordFields(leaveBalanceSchema);

export const LeaveBalance = model<LeaveBalanceDoc>('LeaveBalance', leaveBalanceSchema);

export const LEAVE_REQUEST_STATUSES = ['pending', 'approved', 'not_approved', 'cancelled', 'mistaken'] as const;

/** What an approved request did to the balance: took days from it, gave them back on cancelling, or left it alone. */
export const LEAVE_BALANCE_EFFECTS = ['deducted', 'restored', 'not_counted'] as const;

export const LEAD_APPROVAL_STATUSES = ['pending', 'approved', 'rejected'] as const;

/** The view of one lead whose projects the person works on. HR decides the request once the leads have answered. */
export interface LeadApproval {
  _id: string;
  leadId: string;
  /** The lead's projects the person is on, which is why this lead was asked. */
  projectIds: string[];
  status: (typeof LEAD_APPROVAL_STATUSES)[number];
  notes?: string;
  decidedAt?: Date;
}

/** A request for one day off. */
export interface LeaveRequestDoc extends RecordFields {
  _id: string;
  employeeId: string;
  leaveDate: Date;
  leaveType: LeaveType;
  reason: string;
  status: (typeof LEAVE_REQUEST_STATUSES)[number];
  /** Unpaid leave, taken when there's no balance left. */
  unpaid: boolean;
  /** For an intern, how many days the leave adds to the end of the internship. */
  extendsInternshipDays?: number;
  balanceEffect?: (typeof LEAVE_BALANCE_EFFECTS)[number];
  deductedAt?: Date;
  leadApprovals: LeadApproval[];
  decidedBy?: string;
  decidedAt?: Date;
  decisionNotes?: string;
}

const leadApprovalSchema = new Schema<LeadApproval>(
  {
    _id: { type: String, required: true },
    leadId: { type: String, required: true },
    projectIds: { type: [String], default: [] },
    status: { type: String, enum: LEAD_APPROVAL_STATUSES, default: 'pending' },
    notes: String,
    decidedAt: Date,
  },
  { _id: false },
);

const leaveRequestSchema = new Schema<LeaveRequestDoc>(
  {
    _id: { type: String, required: true },
    employeeId: { type: String, required: true },
    leaveDate: { type: Date, required: true },
    leaveType: { type: String, enum: LEAVE_TYPES, default: 'casual' },
    reason: { type: String, required: true },
    status: { type: String, enum: LEAVE_REQUEST_STATUSES, default: 'pending', index: true },
    unpaid: { type: Boolean, default: false },
    extendsInternshipDays: { type: Number, min: 0 },
    balanceEffect: { type: String, enum: LEAVE_BALANCE_EFFECTS },
    deductedAt: Date,
    leadApprovals: { type: [leadApprovalSchema], default: [] },
    decidedBy: String,
    decidedAt: Date,
    decisionNotes: String,
  },
  { timestamps: true },
);

leaveRequestSchema.index({ employeeId: 1, leaveDate: -1 });
leaveRequestSchema.index({ 'leadApprovals.leadId': 1, 'leadApprovals.status': 1 });
addRecordFields(leaveRequestSchema);

export const LeaveRequest = model<LeaveRequestDoc>('LeaveRequest', leaveRequestSchema);
