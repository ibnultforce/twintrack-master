import { loadConfig } from '../config.js';
import { connectDatabase, disconnectDatabase } from '../db.js';
import { readSeedFiles, seedDatabase } from './seedDatabase.js';

const config = loadConfig();

try {
  await connectDatabase(config.mongodbUri);
  const result = await seedDatabase({
    files: readSeedFiles(),
    password: process.env.SEED_PASSWORD || 'demo1234',
    nodeEnv: config.nodeEnv,
  });
  for (const { key, version, created } of result.modules) {
    console.log(`Module ${key} ${version}: ${created ? 'added' : 'updated'}`);
  }
  console.log(`Users: ${result.usersCreated} added, ${result.usersUpdated} updated`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await disconnectDatabase();
}
