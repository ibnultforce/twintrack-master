import { Schema, model } from 'mongoose';

/** One login. The refresh token rotates inside this document, and only hashes of it are stored. */
export interface SessionDoc {
  _id: string;
  userId: string;
  tokenHash: string;
  previousHash?: string;
  usedHashes: string[];
  rotatedAt?: Date;
  /** Moves forward on each rotation, up to absoluteExpiresAt. */
  expiresAt: Date;
  absoluteExpiresAt: Date;
  revokedAt?: Date;
  /** Set when a super admin started this session to see the app as this person. Development only. */
  impersonatorId?: string;
  /** The super admin's own session, which they return to when they stop. */
  impersonatorSessionId?: string;
  createdAt: Date;
  updatedAt: Date;
}

const sessionSchema = new Schema<SessionDoc>(
  {
    _id: { type: String, required: true },
    userId: { type: String, required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    previousHash: String,
    usedHashes: { type: [String], default: [], index: true },
    rotatedAt: Date,
    expiresAt: { type: Date, required: true },
    absoluteExpiresAt: { type: Date, required: true, expires: 0 },
    revokedAt: Date,
    impersonatorId: String,
    impersonatorSessionId: String,
  },
  { timestamps: true },
);

export const Session = model<SessionDoc>('Session', sessionSchema);
