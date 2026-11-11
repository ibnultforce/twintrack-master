import { Schema, model } from 'mongoose';

/** Why a link was sent: a new person setting their first password, or someone replacing a password. */
export const PASSWORD_LINK_PURPOSES = ['invite', 'reset'] as const;
export type PasswordLinkPurpose = (typeof PASSWORD_LINK_PURPOSES)[number];

/** An emailed one-time link for setting a password. Only a hash of the token is stored, so a database leak can't use it. */
export interface PasswordLinkDoc {
  _id: string;
  userId: string;
  tokenHash: string;
  purpose: PasswordLinkPurpose;
  /** Who asked for the link to be sent. */
  createdBy: string;
  expiresAt: Date;
  createdAt: Date;
}

const passwordLinkSchema = new Schema<PasswordLinkDoc>(
  {
    _id: { type: String, required: true },
    userId: { type: String, required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    purpose: { type: String, enum: PASSWORD_LINK_PURPOSES, required: true },
    createdBy: { type: String, required: true },
    // MongoDB removes a link once it expires.
    expiresAt: { type: Date, required: true, expires: 0 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export const PasswordLink = model<PasswordLinkDoc>('PasswordLink', passwordLinkSchema);
