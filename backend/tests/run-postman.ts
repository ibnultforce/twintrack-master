// Runs the Postman collection with Newman against its own copy of the API, on a free port and in its own database.
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import newman from 'newman';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { connectDatabase, disconnectDatabase } from '../src/db.js';
import { appModels } from '../src/modules/models.js';
import { seedDatabase } from '../src/seed/seedDatabase.js';
import { readSeedFiles } from './helpers/testAccess.js';

const postmanFile = (name: string) => fileURLToPath(new URL(`../../postman/${name}`, import.meta.url));

const webOrigin = 'http://twintrack.localhost:3100';
// Only used in this run's own database, so it can be a fixed value for the collection to sign in with.
const seedPassword = 'postman-test-password';

const config = loadConfig({
  ...process.env,
  ALLOWED_ORIGINS: webOrigin,
  MODULE_FRONTEND_URLS: '',
  LOG_LEVEL: 'silent',
  REFRESH_COOKIE_SECURE: 'false',
  JWT_ACCESS_SECRET: randomBytes(48).toString('base64url'),
  // The collection checks signing in as someone else, which only development allows.
  IMPERSONATION_ENABLED: 'true',
  // Files the collection uploads go to a temporary folder, never the repository.
  STORAGE_DIR: join(tmpdir(), 'twintrack-postman-uploads'),
});

const uri = new URL(config.mongodbUri);
uri.pathname = '/twintrack_postman';
await connectDatabase(uri.toString());
// Starts from nothing each run, so people, modules and failed attempts from the last run can't change the results.
await Promise.all(appModels.map((model) => model.collection.deleteMany({})));
await seedDatabase({ files: readSeedFiles(), password: seedPassword, nodeEnv: config.nodeEnv });

const server = createApp(config).listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const { port } = server.address() as AddressInfo;

const failures = await new Promise<number>((resolve, reject) => {
  newman.run(
    {
      collection: postmanFile('twintrack-master.postman_collection.json'),
      environment: postmanFile('twintrack-local.postman_environment.json'),
      envVar: [
        { key: 'baseUrl', value: `http://127.0.0.1:${port}` },
        { key: 'webOrigin', value: webOrigin },
        { key: 'password', value: seedPassword },
      ],
      reporters: 'cli',
    },
    (err, summary) => (err ? reject(err) : resolve(summary.run.failures.length)),
  );
});

server.close();
await disconnectDatabase();
process.exit(failures === 0 ? 0 : 1);
