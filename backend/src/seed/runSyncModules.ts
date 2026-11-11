import { loadConfig } from '../config.js';
import { connectDatabase, disconnectDatabase } from '../db.js';
import { readManifestFiles } from './seedFiles.js';
import { syncModules } from './syncModules.js';

const config = loadConfig();

try {
  await connectDatabase(config.mongodbUri);
  for (const { key, version } of await syncModules(readManifestFiles())) console.log(`Module ${key} ${version} loaded`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await disconnectDatabase();
}
