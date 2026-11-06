import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, inject } from 'vitest';
import { masterModels } from '../../src/modules/master/models/index.js';

/** Gives a test file its own empty database, cleared before each test with indexes kept. */
export function useTestDatabase(): void {
  beforeAll(async () => {
    await mongoose.connect(inject('mongoUri'), { dbName: `test_${randomUUID()}` });
    await Promise.all(masterModels.map((model) => model.init()));
  });

  beforeEach(async () => {
    await Promise.all(masterModels.map((model) => model.collection.deleteMany({})));
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
}
