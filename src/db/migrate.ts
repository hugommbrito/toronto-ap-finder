import 'dotenv/config';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from './client';
import { loadEnv } from '@/config/env';

async function main(): Promise<void> {
  const env = loadEnv();
  const handle = createDb(env.DATABASE_URL, { max: 1 });
  try {
    await migrate(handle.db, { migrationsFolder: 'src/db/migrations' });
    console.log('migrations applied');
  } finally {
    await handle.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
