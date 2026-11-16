import { loadConfig } from '../config.js';
import { connectDatabase, disconnectDatabase } from '../db.js';
import { renameModule } from './renameModule.js';

// npm run migrate:rename-module -- <old key> <new key> <new base URL>, such as: tasks projects /projects
const [fromKey, toKey, toBaseUrl] = process.argv.slice(2);
const config = loadConfig();

try {
  if (!fromKey || !toKey || !toBaseUrl) throw new Error('Usage: npm run migrate:rename-module -- <old key> <new key> <new base URL>');
  await connectDatabase(config.mongodbUri);
  const result = await renameModule({ fromKey, toKey, toBaseUrl });
  console.log(`Module ${fromKey} is now ${toKey} at ${toBaseUrl}. Updated:`, result);
  console.log('Next, load the renamed manifest with: npm run seed:modules');
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await disconnectDatabase();
}
