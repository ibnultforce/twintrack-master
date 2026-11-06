import { loadConfig } from '../config.js';
import { connectDatabase, disconnectDatabase } from '../db.js';
import { seedDatabase } from './seedDatabase.js';
import { readSeedFiles } from './seedFiles.js';

const config = loadConfig();
const seedPassword = process.env.SEED_PASSWORD;

try {
  if (!seedPassword) throw new Error('Set SEED_PASSWORD in backend/.env before running the seed.');

  await connectDatabase(config.mongodbUri);
  const result = await seedDatabase({ files: readSeedFiles(), password: seedPassword, nodeEnv: config.nodeEnv });
  for (const { key, version, created } of result.modules) {
    console.log(`Module ${key} ${version}: ${created ? 'added' : 'updated'}`);
  }
  console.log(`Users: ${result.usersCreated} added, ${result.usersUpdated} updated`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await disconnectDatabase();
}
