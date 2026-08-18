import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { loadEnv } from '@/config/env';
import { createDb, type Database, type DbHandle } from './client';

export const DB = Symbol('DB');

@Global()
@Module({
  providers: [
    {
      provide: DB,
      useFactory: (): DbHandle => createDb(loadEnv().DATABASE_URL),
    },
    {
      provide: 'DATABASE',
      useFactory: (handle: DbHandle): Database => handle.db,
      inject: [DB],
    },
  ],
  exports: [DB, 'DATABASE'],
})
export class DbModule implements OnApplicationShutdown {
  // DbHandle is an interface, so the token has to be explicit — Nest has no runtime type to infer.
  constructor(@Inject(DB) private readonly handle: DbHandle) {}

  async onApplicationShutdown(): Promise<void> {
    await this.handle.close();
  }
}
