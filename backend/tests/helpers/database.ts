import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, inject } from 'vitest';
import { AuditLog } from '../../src/models/auditLog.js';
import { Module } from '../../src/models/module.js';
import { Session } from '../../src/models/session.js';
import { User } from '../../src/models/user.js';

const models = [User, Session, Module, AuditLog];

/** Gives a test file its own empty database, cleared before each test with indexes kept. */
export function useTestDatabase(): void {
  beforeAll(async () => {
    await mongoose.connect(inject('mongoUri'), { dbName: `test_${randomUUID()}` });
    await Promise.all(models.map((model) => model.init()));
  });

  beforeEach(async () => {
    await Promise.all(models.map((model) => model.collection.deleteMany({})));
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
}
