import { Schema, model } from 'mongoose';

/**
 * A personal access token someone made for a tool such as Claude Code. It acts as that person, with exactly their
 * access as read on each call. Only a hash is stored, so the token is shown once, when it's made.
 */
export interface ApiTokenDoc {
  _id: string;
  userId: string;
  name: string;
  tokenHash: string;
  /** The token's first characters, so its owner can tell their tokens apart. */
  prefix: string;
  lastUsedAt?: Date;
  /** Missing means it never expires. */
  expiresAt?: Date;
  revokedAt?: Date;
  createdAt: Date;
}

const apiTokenSchema = new Schema<ApiTokenDoc>(
  {
    _id: { type: String, required: true },
    userId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true },
    tokenHash: { type: String, required: true, unique: true },
    prefix: { type: String, required: true },
    lastUsedAt: Date,
    expiresAt: Date,
    revokedAt: Date,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export const ApiToken = model<ApiTokenDoc>('ApiToken', apiTokenSchema);
