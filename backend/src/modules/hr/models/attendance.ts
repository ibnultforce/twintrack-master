import { Schema, model } from 'mongoose';
import { addRecordFields, type RecordFields } from '../../../lib/records/recordFields.js';

export const ATTENDANCE_STATUSES = ['present', 'absent', 'late', 'half_day'] as const;
/** Entered by HR, or sent by the attendance device. */
export const ATTENDANCE_SOURCES = ['manual', 'device'] as const;
export const PUNCH_DIRECTIONS = ['in', 'out'] as const;

/** One swipe on the attendance device. */
export interface AttendancePunch {
  _id: string;
  direction: (typeof PUNCH_DIRECTIONS)[number];
  occurredAt: Date;
}

/** One person's attendance on one day. */
export interface AttendanceDoc extends RecordFields {
  _id: string;
  employeeId: string;
  /** The day, at midnight UTC. */
  workDate: Date;
  status: (typeof ATTENDANCE_STATUSES)[number];
  checkInAt?: Date;
  checkOutAt?: Date;
  source: (typeof ATTENDANCE_SOURCES)[number];
  notes?: string;
  /** Every swipe that day. The first in and last out set checkInAt and checkOutAt. */
  punches: AttendancePunch[];
}

const punchSchema = new Schema<AttendancePunch>(
  {
    _id: { type: String, required: true },
    direction: { type: String, enum: PUNCH_DIRECTIONS, required: true },
    occurredAt: { type: Date, required: true },
  },
  { _id: false },
);

const attendanceSchema = new Schema<AttendanceDoc>(
  {
    _id: { type: String, required: true },
    employeeId: { type: String, required: true },
    workDate: { type: Date, required: true },
    status: { type: String, enum: ATTENDANCE_STATUSES, required: true },
    checkInAt: Date,
    checkOutAt: Date,
    source: { type: String, enum: ATTENDANCE_SOURCES, required: true },
    notes: String,
    punches: { type: [punchSchema], default: [] },
  },
  { timestamps: true },
);

attendanceSchema.index({ employeeId: 1, workDate: 1 }, { unique: true });
attendanceSchema.index({ workDate: 1 });
addRecordFields(attendanceSchema);

export const Attendance = model<AttendanceDoc>('Attendance', attendanceSchema);
