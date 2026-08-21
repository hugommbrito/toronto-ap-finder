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
import { ProbeService } from './sources/probe/probe.service';
import { SourceRegistry } from './sources/source.registry';
import { WatchdogService } from './pipeline/watchdog.service';
import { OperationsController } from './operations/operations.controller';
import { OperationsService } from './operations/operations.service';
import { RentSafeService } from './rentsafe/rentsafe.service';
import { ListingVerifier } from './verification/listing-verifier';

/**
 * Database, seeded geography, profiles, the collection pipeline, health and operations.
 *
 * SchedulerService drives a cycle every 20 minutes; set CYCLE_ENABLED=false to run the
 * service without polling and drive cycles by hand instead. SourceRegistry owns the source
 * instances for the life of the process, which is what keeps a rate limiter's open circuit from
 * being forgotten between cycles.
 */
@Module({
  imports: [DbModule, ScheduleModule.forRoot()],
  controllers: [HealthController, OperationsController],
  providers: [
    GeoService,
    ProfilesService,
    ListingsRepository,
    TelegramNotifier,
    ListingVerifier,
    PipelineService,
    SchedulerService,
    ProbeService,
    SourceRegistry,
    WatchdogService,
    OperationsService,
    RentSafeService,
  ],
  exports: [GeoService, ProfilesService, PipelineService, ProbeService, RentSafeService],
})
export class AppModule {}
