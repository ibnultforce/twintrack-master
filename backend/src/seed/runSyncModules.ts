import { loadConfig } from '../config.js';
import { connectDatabase, disconnectDatabase } from '../db.js';
import { readManifestFiles } from './seedFiles.js';
import { syncModules } from './syncModules.js';

const config = loadConfig();

try {
  await connectDatabase(config.mongodbUri);
  const { loaded, removed, keptWithCustomObjects } = await syncModules(readManifestFiles());
  for (const { key, version } of loaded) console.log(`Module ${key} ${version} loaded`);
  for (const key of removed) console.log(`Module ${key} removed: its manifest file is gone`);
  for (const key of keptWithCustomObjects) {
    console.warn(`Module ${key} kept: its manifest file is gone, but it holds custom objects. Remove it on the Modules screen if it should go.`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await disconnectDatabase();
}
