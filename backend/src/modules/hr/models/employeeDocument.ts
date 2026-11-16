import { Schema, model } from 'mongoose';

export const EMPLOYEE_DOCUMENT_TYPES = [
  'photo',
  'cv',
  'nid_front',
  'nid_back',
  'nid_copy',
  'passport_copy',
  'etin_certificate',
  'education_certificate',
  'experience_certificate',
  'tax_exemption_declaration',
  'work_permit',
] as const;
export type EmployeeDocumentType = (typeof EMPLOYEE_DOCUMENT_TYPES)[number];

/** The part of the HR file a document backs up, when it's one entry rather than the person as a whole. */
export const DOCUMENT_ENTRY_TYPES = ['education', 'workExperience', 'training'] as const;

export const EMPLOYEE_DOCUMENT_STATUSES = ['uploading', 'ready'] as const;

/**
 * A file in someone's HR file, such as a CV or an NID scan. The bytes are in file storage (R2, or the local disk in
 * development), uploaded the same way task files are.
 */
export interface EmployeeDocumentDoc {
  _id: string;
  employeeId: string;
  type: EmployeeDocumentType;
  /** With entryId: the education, work experience or training entry in the employee profile it belongs to. */
  entryType?: (typeof DOCUMENT_ENTRY_TYPES)[number];
  entryId?: string;
  /** As uploaded, for showing only. The storage key never contains it. */
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  /** hr/<employeeId>/<documentId> */
  storageKey: string;
  status: (typeof EMPLOYEE_DOCUMENT_STATUSES)[number];
  uploadId?: string;
  uploadedBy: string;
  createdAt: Date;
}

const employeeDocumentSchema = new Schema<EmployeeDocumentDoc>(
  {
    _id: { type: String, required: true },
    employeeId: { type: String, required: true, index: true },
    type: { type: String, enum: EMPLOYEE_DOCUMENT_TYPES, required: true },
    entryType: { type: String, enum: DOCUMENT_ENTRY_TYPES },
    entryId: String,
    fileName: { type: String, required: true },
    mimeType: { type: String, required: true },
    sizeBytes: { type: Number, required: true, min: 1 },
    storageKey: { type: String, required: true, unique: true },
    status: { type: String, enum: EMPLOYEE_DOCUMENT_STATUSES, default: 'uploading' },
    uploadId: String,
    uploadedBy: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export const EmployeeDocument = model<EmployeeDocumentDoc>('EmployeeDocument', employeeDocumentSchema);
