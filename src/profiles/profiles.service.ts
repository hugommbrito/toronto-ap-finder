import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Database } from '@/db/client';
import { profiles } from '@/db/schema';
import { tenantProfileSchema, type TenantProfile } from './profile.schema';

@Injectable()
export class ProfilesService {
  private readonly logger = new Logger(ProfilesService.name);

  constructor(@Inject('DATABASE') private readonly db: Database) {}

  /**
   * Reads profiles as data and validates them on the way in.
   *
   * The jsonb columns are the entire configuration surface, so a malformed one has to fail
   * here, loudly and by id, rather than surfacing later as a listing that mysteriously
   * never matches. Note there is nothing in this file — or anywhere downstream — that knows
   * the name of any particular profile.
   */
  async findActive(): Promise<TenantProfile[]> {
    const rows = await this.db.select().from(profiles).where(eq(profiles.active, true));
    return rows.flatMap((row) => {
      const parsed = tenantProfileSchema.safeParse(row);
      if (!parsed.success) {
        this.logger.error(`Profile "${row.id}" is invalid and will be skipped: ${parsed.error.message}`);
        return [];
      }
      return [parsed.data];
    });
  }

  async findById(id: string): Promise<TenantProfile | null> {
    const [row] = await this.db.select().from(profiles).where(eq(profiles.id, id)).limit(1);
    if (!row) return null;
    return tenantProfileSchema.parse(row);
  }
}
