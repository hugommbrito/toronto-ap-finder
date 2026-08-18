import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';
import { createDb } from './db/client';
import { needsSeeding, runSeed } from './seed';

/**
 * Migrations and first-run seeding happen before the app opens a port.
 *
 * A deployment that boots against an unmigrated or unseeded database does not crash — it
 * runs perfectly and matches nothing, which is the failure mode hardest to notice. Seeding
 * reads the committed files under data/seed/, so a cold start needs no external service.
 *
 * Both steps are idempotent, so a redeploy is a no-op. This assumes a single instance;
 * running several replicas would need an advisory lock around the migration.
 */
async function prepareDatabase(logger: Logger): Promise<void> {
  const env = loadEnv();
  const handle = createDb(env.DATABASE_URL, { max: 1 });
  try {
    await migrate(handle.db, { migrationsFolder: 'src/db/migrations' });
    logger.log('migrations applied');

    if (await needsSeeding(handle.db)) {
      logger.log('empty database — seeding geography and profiles');
      await runSeed(handle.db, { quiet: true });
    }
  } finally {
    await handle.close();
  }
}

async function bootstrap(): Promise<void> {
  const logger = new Logger('bootstrap');
  const env = loadEnv();

  await prepareDatabase(logger);

  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  // Railway routes to the container's port and expects it bound on all interfaces.
  await app.listen(env.PORT, '0.0.0.0');
  logger.log(`listening on :${env.PORT} — health at /health`);
}

bootstrap().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
