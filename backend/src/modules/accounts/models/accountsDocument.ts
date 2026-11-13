import { Schema, model } from 'mongoose';

/** What a document is evidence for. A payroll item is one person's pay in one run. */
export const DOCUMENT_OWNER_TYPES = ['bill', 'payment', 'receipt', 'payrollItem'] as const;
export type DocumentOwnerType = (typeof DOCUMENT_OWNER_TYPES)[number];

export const DOCUMENT_STATUSES = ['uploading', 'ready'] as const;

/**
 * Evidence attached to money records, such as a vendor's bill or a bank's transfer slip. The bytes are in file storage
 * (R2, or the local disk in development), uploaded straight from the browser as task files are.
 */
export interface AccountsDocumentDoc {
  _id: string;
  ownerType: DocumentOwnerType;
  /** The bill, payment or receipt id, or the payroll item id. */
  ownerId: string;
  /** For a payroll item: the run it's in. */
  runId?: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  storageKey: string;
  status: (typeof DOCUMENT_STATUSES)[number];
  uploadId?: string;
  uploadedBy: string;
  createdAt: Date;
}

const accountsDocumentSchema = new Schema<AccountsDocumentDoc>(
  {
    _id: { type: String, required: true },
    ownerType: { type: String, enum: DOCUMENT_OWNER_TYPES, required: true },
    ownerId: { type: String, required: true },
    runId: String,
    fileName: { type: String, required: true },
    mimeType: { type: String, required: true },
    sizeBytes: { type: Number, required: true, min: 1 },
    storageKey: { type: String, required: true, unique: true },
    status: { type: String, enum: DOCUMENT_STATUSES, default: 'uploading' },
    uploadId: String,
    uploadedBy: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
accountsDocumentSchema.index({ ownerType: 1, ownerId: 1 });

export const AccountsDocument = model<AccountsDocumentDoc>('AccountsDocument', accountsDocumentSchema, 'accounts_documents');
