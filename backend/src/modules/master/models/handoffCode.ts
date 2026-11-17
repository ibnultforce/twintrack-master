import { Schema, model } from 'mongoose';

/**
 * A one-time code that carries a signed-in person from Master to a module's frontend. Only a hash is stored, it lasts
 * a minute, and exchanging it deletes it, so a code seen in a log or browser history is already useless.
 */
export interface HandoffCodeDoc {
  _id: string;
  codeHash: string;
  userId: string;
  /** The Master session it was made from, so signing out of Master also ends the module's access. */
  sessionId: string;
  moduleKey: string;
  redirectUrl: string;
  expiresAt: Date;
  createdAt: Date;
}

const handoffCodeSchema = new Schema<HandoffCodeDoc>(
  {
    _id: { type: String, required: true },
    codeHash: { type: String, required: true, unique: true },
    userId: { type: String, required: true },
    sessionId: { type: String, required: true },
    moduleKey: { type: String, required: true },
    redirectUrl: { type: String, required: true },
    // MongoDB removes a code once it expires; the exchange also checks the time, since that removal can lag.
    expiresAt: { type: Date, required: true, expires: 0 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export const HandoffCode = model<HandoffCodeDoc>('HandoffCode', handoffCodeSchema);
