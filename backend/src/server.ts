import { createApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { connectDatabase, disconnectDatabase } from './db.js';

async function main() {
  const config = loadConfig();
  await connectDatabase(config.mongodbUri);

  const server = createApp(config).listen(config.port, () => {
    console.log(`Master API listening on port ${config.port}`);
  });

  const shutdown = () => {
    server.close(() => {
      void disconnectDatabase().finally(() => process.exit(0));
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  console.error(err instanceof ConfigError ? err.message : err);
  process.exit(1);
});
