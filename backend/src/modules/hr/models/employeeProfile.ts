import { Schema, model } from 'mongoose';
import { addRecordFields, type RecordFields } from '../../../lib/records/recordFields.js';

/*
 * A person's HR file. Master keeps who they are in the app (name, email, title, department, org role, manager);
 * this keeps what HR knows about them. There is one per person, keyed by employeeId (the Master user id).
 */

export const GENDERS = ['male', 'female', 'other'] as const;
export const MARITAL_STATUSES = ['single', 'married', 'divorced', 'widowed'] as const;
export const BLOOD_GROUPS = ['a_positive', 'a_negative', 'b_positive', 'b_negative', 'ab_positive', 'ab_negative', 'o_positive', 'o_negative'] as const;
export const EMPLOYMENT_TYPES = ['permanent', 'contractual', 'probation', 'academic_internship', 'part_time'] as const;
export const EMPLOYMENT_STATUSES = ['active', 'probation', 'notice_period', 'resigned', 'terminated'] as const;
export const EMPLOYEE_CATEGORIES = ['billable', 'non_billable'] as const;
export const WORK_LOCATIONS = ['on_site', 'remote'] as const;
export const SHIFT_TYPES = ['standard', 'flexible'] as const;
export const WEEK_DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
export const FINAL_SETTLEMENT_STATUSES = ['pending', 'processed'] as const;
export const QUALIFICATION_LEVELS = ['ssc', 'o_level', 'hsc', 'a_level', 'bachelors', 'masters', 'phd', 'other'] as const;

export interface EducationEntry {
  _id: string;
  level?: (typeof QUALIFICATION_LEVELS)[number];
  institutionName?: string;
  fieldOfStudy?: string;
  yearOfPassing?: number;
  result?: string;
}

export interface WorkExperienceEntry {
  _id: string;
  companyName: string;
  designation?: string;
  startedOn?: Date;
  endedOn?: Date;
  reasonForLeaving?: string;
  referenceContact?: string;
}

export interface CertificationEntry {
  _id: string;
  name: string;
  issuingOrganization?: string;
  issuedOn?: Date;
  expiresOn?: Date;
}

export interface NomineeEntry {
  _id: string;
  name: string;
  relationship: string;
  /** Shares across a person's nominees add up to 100. */
  sharePercent: number;
  contactNumber?: string;
}

export interface TrainingEntry {
  _id: string;
  courseName: string;
  trainedOn?: Date;
  notes?: string;
}

export interface EmployeeProfileDoc extends RecordFields {
  _id: string;
  employeeId: string;

  // Personal
  firstName?: string;
  lastName?: string;
  /** The full date when the year is known. Otherwise only birthDay and birthMonth are set, for birthday lists. */
  dateOfBirth?: Date;
  birthDay?: number;
  birthMonth?: number;
  gender?: (typeof GENDERS)[number];
  maritalStatus?: (typeof MARITAL_STATUSES)[number];
  spouseName?: string;
  fatherName?: string;
  motherName?: string;
  bloodGroup?: (typeof BLOOD_GROUPS)[number];
  nationality?: string;
  religion?: string;

  // Contact
  personalEmail?: string;
  personalMobile?: string;
  whatsappNumber?: string;
  presentAddress?: string;
  permanentAddress?: string;
  emergencyContactName?: string;
  emergencyContactRelationship?: string;
  emergencyContactNumber?: string;

  // Identity numbers. Hidden by field security unless a profile grants them.
  nationalIdNumber?: string;
  passportNumber?: string;
  birthCertificateNumber?: string;
  taxIdNumber?: string;

  // Employment
  joinedOn?: Date;
  internshipStartedOn?: Date;
  employmentType?: (typeof EMPLOYMENT_TYPES)[number];
  employmentStatus?: (typeof EMPLOYMENT_STATUSES)[number];
  employeeCategory?: (typeof EMPLOYEE_CATEGORIES)[number];
  workLocation?: (typeof WORK_LOCATIONS)[number];
  probationPeriodMonths?: number;
  confirmedOn?: Date;
  confirmationNotes?: string;
  lastAppraisalOn?: Date;

  // Benefits and statutory enrolment
  laborWelfareFundEnrolled: boolean;
  groupHealthInsuranceEnrolled: boolean;
  groupHealthInsurancePolicyNumber?: string;

  // Work pattern
  leavePolicy?: string;
  weeklyOffDays: (typeof WEEK_DAYS)[number][];
  shiftType?: (typeof SHIFT_TYPES)[number];
  /** The person's id on the attendance device, used to match imported punches. */
  biometricAttendanceId?: string;

  // Leaving
  leftOn?: Date;
  noticePeriodServedDays?: number;
  exitInterviewNotes?: string;
  clearanceItDone: boolean;
  clearanceFinanceDone: boolean;
  clearanceAdminDone: boolean;
  clearanceHrDone: boolean;
  finalSettlementStatus?: (typeof FINAL_SETTLEMENT_STATUSES)[number];
  rehireEligible?: boolean;

  // Background. Small lists that are read and edited with the profile, so they live in it.
  education: EducationEntry[];
  workExperience: WorkExperienceEntry[];
  certifications: CertificationEntry[];
  nominees: NomineeEntry[];
  trainings: TrainingEntry[];
}

const educationSchema = new Schema<EducationEntry>(
  {
    _id: { type: String, required: true },
    level: { type: String, enum: QUALIFICATION_LEVELS },
    institutionName: String,
    fieldOfStudy: String,
    yearOfPassing: { type: Number, min: 1900, max: 2200 },
    result: String,
  },
  { _id: false },
);

const workExperienceSchema = new Schema<WorkExperienceEntry>(
  {
    _id: { type: String, required: true },
    companyName: { type: String, required: true },
    designation: String,
    startedOn: Date,
    endedOn: Date,
    reasonForLeaving: String,
    referenceContact: String,
  },
  { _id: false },
);

const certificationSchema = new Schema<CertificationEntry>(
  {
    _id: { type: String, required: true },
    name: { type: String, required: true },
    issuingOrganization: String,
    issuedOn: Date,
    expiresOn: Date,
  },
  { _id: false },
);

const nomineeSchema = new Schema<NomineeEntry>(
  {
    _id: { type: String, required: true },
    name: { type: String, required: true },
    relationship: { type: String, required: true },
    sharePercent: { type: Number, required: true, min: 0, max: 100 },
    contactNumber: String,
  },
  { _id: false },
);

const trainingSchema = new Schema<TrainingEntry>(
  {
    _id: { type: String, required: true },
    courseName: { type: String, required: true },
    trainedOn: Date,
    notes: String,
  },
  { _id: false },
);

const employeeProfileSchema = new Schema<EmployeeProfileDoc>(
  {
    _id: { type: String, required: true },
    employeeId: { type: String, required: true, unique: true },

    firstName: String,
    lastName: String,
    dateOfBirth: Date,
    birthDay: { type: Number, min: 1, max: 31 },
    birthMonth: { type: Number, min: 1, max: 12 },
    gender: { type: String, enum: GENDERS },
    maritalStatus: { type: String, enum: MARITAL_STATUSES },
    spouseName: String,
    fatherName: String,
    motherName: String,
    bloodGroup: { type: String, enum: BLOOD_GROUPS },
    nationality: String,
    religion: String,

    personalEmail: { type: String, lowercase: true, trim: true },
    personalMobile: String,
    whatsappNumber: String,
    presentAddress: String,
    permanentAddress: String,
    emergencyContactName: String,
    emergencyContactRelationship: String,
    emergencyContactNumber: String,

    nationalIdNumber: { type: String, unique: true, sparse: true },
    passportNumber: String,
    birthCertificateNumber: String,
    taxIdNumber: String,

    joinedOn: Date,
    internshipStartedOn: Date,
    employmentType: { type: String, enum: EMPLOYMENT_TYPES },
    employmentStatus: { type: String, enum: EMPLOYMENT_STATUSES, index: true },
    employeeCategory: { type: String, enum: EMPLOYEE_CATEGORIES },
    workLocation: { type: String, enum: WORK_LOCATIONS },
    probationPeriodMonths: { type: Number, min: 0 },
    confirmedOn: Date,
    confirmationNotes: String,
    lastAppraisalOn: Date,

    laborWelfareFundEnrolled: { type: Boolean, default: false },
    groupHealthInsuranceEnrolled: { type: Boolean, default: false },
    groupHealthInsurancePolicyNumber: String,

    leavePolicy: String,
    weeklyOffDays: { type: [{ type: String, enum: WEEK_DAYS }], default: [] },
    shiftType: { type: String, enum: SHIFT_TYPES },
    biometricAttendanceId: { type: String, unique: true, sparse: true },

    leftOn: Date,
    noticePeriodServedDays: { type: Number, min: 0 },
    exitInterviewNotes: String,
    clearanceItDone: { type: Boolean, default: false },
    clearanceFinanceDone: { type: Boolean, default: false },
    clearanceAdminDone: { type: Boolean, default: false },
    clearanceHrDone: { type: Boolean, default: false },
    finalSettlementStatus: { type: String, enum: FINAL_SETTLEMENT_STATUSES },
    rehireEligible: Boolean,

    education: { type: [educationSchema], default: [] },
    workExperience: { type: [workExperienceSchema], default: [] },
    certifications: { type: [certificationSchema], default: [] },
    nominees: { type: [nomineeSchema], default: [] },
    trainings: { type: [trainingSchema], default: [] },
  },
  { timestamps: true },
);

addRecordFields(employeeProfileSchema);

export const EmployeeProfile = model<EmployeeProfileDoc>('EmployeeProfile', employeeProfileSchema);
