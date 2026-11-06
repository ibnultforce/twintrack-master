import type { ClientRateLimitInfo, Options, Store } from 'express-rate-limit';
import { RateLimitCounter } from '../models/rateLimitCounter.js';

/** Keeps rate limit counts in MongoDB, so every API instance sees the same totals and a restart doesn't clear them. */
export class MongoRateLimitStore implements Store {
  private windowMilliseconds = 0;

  /** The prefix keeps each limiter's counts apart, because they all share one collection. */
  constructor(readonly prefix: string) {}

  init(options: Options): void {
    this.windowMilliseconds = options.windowMs;
  }

  /** One atomic update, so requests arriving together on different instances can't lose a count. */
  async increment(key: string): Promise<ClientRateLimitInfo> {
    const now = new Date();
    const isWindowOpen = { $gt: ['$resetAt', now] };
    // The driver's own collection, because Mongoose would try to cast these expressions to the schema's types.
    const counter = await RateLimitCounter.collection.findOneAndUpdate(
      { _id: this.counterId(key) as never },
      [
        {
          $set: {
            hits: { $cond: [isWindowOpen, { $add: ['$hits', 1] }, 1] },
            resetAt: { $cond: [isWindowOpen, '$resetAt', new Date(now.getTime() + this.windowMilliseconds)] },
          },
        },
      ],
      { upsert: true, returnDocument: 'after' },
    );
    if (!counter) throw new Error('The rate limit counter update returned nothing.');
    return { totalHits: counter.hits as number, resetTime: counter.resetAt as Date };
  }

  async decrement(key: string): Promise<void> {
    await RateLimitCounter.updateOne({ _id: this.counterId(key), hits: { $gt: 0 } }, { $inc: { hits: -1 } });
  }

  async resetKey(key: string): Promise<void> {
    await RateLimitCounter.deleteOne({ _id: this.counterId(key) });
  }

  private counterId(key: string): string {
    return `${this.prefix}:${key}`;
  }
}
