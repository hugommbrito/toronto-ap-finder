import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { DbModule } from './db/db.module';
import { GeoService } from './geo/geo.service';
import { ProfilesService } from './profiles/profiles.service';
import { HealthController } from './health/health.controller';
import { ListingsRepository } from './listings/listings.repository';
import { TelegramNotifier } from './notifications/telegram.notifier';
import { PipelineService } from './pipeline/pipeline.service';
import { SchedulerService } from './pipeline/scheduler.service';
import { ListingVerifier } from './verification/listing-verifier';

/**
 * Database, seeded geography, profiles, the Kijiji pipeline and health.
 *
 * SchedulerService drives a cycle every 20 minutes; set CYCLE_ENABLED=false to run the
 * service without polling and drive cycles by hand instead.
 */
@Module({
  imports: [DbModule, ScheduleModule.forRoot()],
  controllers: [HealthController],
  providers: [
    GeoService,
    ProfilesService,
    ListingsRepository,
    TelegramNotifier,
    ListingVerifier,
    PipelineService,
    SchedulerService,
  ],
  exports: [GeoService, ProfilesService, PipelineService],
})
export class AppModule {}
