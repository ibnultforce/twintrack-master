import { Schema, model } from 'mongoose';

/** Failed attempts from one address in the current window. MongoDB removes each one after its window ends. */
export interface RateLimitCounterDoc {
  _id: string;
  hits: number;
  resetAt: Date;
}

const rateLimitCounterSchema = new Schema<RateLimitCounterDoc>({
  _id: { type: String, required: true },
  hits: { type: Number, required: true },
  resetAt: { type: Date, required: true, expires: 0 },
});

export const RateLimitCounter = model<RateLimitCounterDoc>('RateLimitCounter', rateLimitCounterSchema);
