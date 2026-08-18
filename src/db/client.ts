import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export type Database = PostgresJsDatabase<typeof schema>;

export interface DbHandle {
  db: Database;
  sql: postgres.Sql;
  close: () => Promise<void>;
}

/** Standalone connection for scripts (seed, migrate). The Nest module wraps this too. */
export function createDb(databaseUrl: string, options: { max?: number } = {}): DbHandle {
  const sql = postgres(databaseUrl, { max: options.max ?? 5, onnotice: () => {} });
  const db = drizzle(sql, { schema });
  return { db, sql, close: () => sql.end({ timeout: 5 }) };
}
