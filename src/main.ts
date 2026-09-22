import 'dotenv/config';
import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
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

/**
 * The browser UI is a static bundle, served from web/dist when one has been built.
 *
 * `express.static` only answers for files that exist, so /health, /operations and /api/* fall
 * through to their controllers untouched — there is no SPA fallback route to fight with them,
 * which is also why the UI routes by hash. The check is on index.html rather than the directory
 * so that a half-built bundle reads as absent instead of being served broken. Absent is fine:
 * `pnpm start:dev` without a web build is the API alone, and the log says so.
 */
function serveWebUi(app: NestExpressApplication, logger: Logger): void {
  const webDist = resolve('web/dist');
  if (!existsSync(join(webDist, 'index.html'))) {
    logger.log('web UI not built (web/dist missing) — serving the API only');
    return;
  }
  app.useStaticAssets(webDist, {
    index: 'index.html',
    setHeaders: (res, path) => {
      // Vite hashes every asset name, so those can be cached forever. index.html is the one file
      // whose content changes under the same name, and caching it makes a deploy invisible.
      res.setHeader(
        'Cache-Control',
        path.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
      );
    },
  });
  logger.log(`web UI served from ${webDist}`);
}

async function bootstrap(): Promise<void> {
  const logger = new Logger('bootstrap');
  const env = loadEnv();

  await prepareDatabase(logger);

  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.enableShutdownHooks();
  serveWebUi(app, logger);
  // Railway routes to the container's port and expects it bound on all interfaces.
  await app.listen(env.PORT, '0.0.0.0');
  logger.log(`listening on :${env.PORT} — health at /health, UI at /`);
}

bootstrap().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
