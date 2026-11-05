// Runs the Postman collection with Newman against its own copy of the API, on a free port and in its own database.
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import newman from 'newman';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { connectDatabase, disconnectDatabase } from '../src/db.js';

const postmanFile = (name: string) => fileURLToPath(new URL(`../../postman/${name}`, import.meta.url));

const webOrigin = 'http://twintrack.localhost:3100';
const config = loadConfig({ ...process.env, ALLOWED_ORIGINS: webOrigin, LOG_LEVEL: 'silent' });

const uri = new URL(config.mongodbUri);
uri.pathname = '/twintrack_postman';
await connectDatabase(uri.toString());

const server = createApp(config).listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const { port } = server.address() as AddressInfo;

const failures = await new Promise<number>((resolve, reject) => {
  newman.run(
    {
      collection: postmanFile('twintrack-master.postman_collection.json'),
      environment: postmanFile('twintrack-local.postman_environment.json'),
      envVar: [{ key: 'baseUrl', value: `http://127.0.0.1:${port}` }, { key: 'webOrigin', value: webOrigin }],
      reporters: 'cli',
    },
    (err, summary) => (err ? reject(err) : resolve(summary.run.failures.length)),
  );
});

server.close();
await disconnectDatabase();
process.exit(failures === 0 ? 0 : 1);
