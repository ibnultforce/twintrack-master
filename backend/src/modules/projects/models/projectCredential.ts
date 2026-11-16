import { Schema, model } from 'mongoose';
import { addRecordFields, type RecordFields } from '../../../lib/records/recordFields.js';

/**
 * A shared login for a project's outside system, such as a client's Salesforce org. The password, passcode and
 * one-time-code secret are encrypted, because people need them back to log in. The secret is never sent out again:
 * the API shows the current code instead.
 */
export interface ProjectCredentialDoc extends RecordFields {
  _id: string;
  projectId: string;
  label: string;
  loginUrl: string;
  username: string;
  passwordEncrypted: string;
  otpSecretEncrypted?: string;
  passcodeEncrypted?: string;
  notes?: string;
}

const projectCredentialSchema = new Schema<ProjectCredentialDoc>(
  {
    _id: { type: String, required: true },
    projectId: { type: String, required: true, index: true },
    label: { type: String, required: true, trim: true },
    loginUrl: { type: String, required: true, trim: true },
    username: { type: String, required: true },
    passwordEncrypted: { type: String, required: true },
    otpSecretEncrypted: String,
    passcodeEncrypted: String,
    notes: String,
  },
  { timestamps: true },
);

addRecordFields(projectCredentialSchema);

export const ProjectCredential = model<ProjectCredentialDoc>('ProjectCredential', projectCredentialSchema);
