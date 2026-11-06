import mongoose, { type ClientSession } from 'mongoose';

export async function connectDatabase(uri: string): Promise<void> {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
}

export function isDatabaseConnected(): boolean {
  return mongoose.connection.readyState === mongoose.ConnectionStates.connected;
}

/** Creates collections and indexes. Call this before a transaction, because they can't be created safely inside one. */
export async function prepareCollections(models: { init(): Promise<unknown> }[]): Promise<void> {
  await Promise.all(models.map((model) => model.init()));
}

/** Runs the work as one transaction, so a failure anywhere saves nothing. */
export function runInTransaction<Result>(work: (session: ClientSession) => Promise<Result>): Promise<Result> {
  return mongoose.connection.transaction(work);
}
