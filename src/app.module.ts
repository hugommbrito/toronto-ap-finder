import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { loadEnv } from './config/env';
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
import { ListingsViewController } from './ui-api/listings-view.controller';
import { ListingsViewRepository } from './ui-api/listings-view.repository';
import { ListingsViewService } from './ui-api/listings-view.service';
import { UI_TOKEN_SOURCE, UiAuthGuard } from './ui-api/ui-auth.guard';

/**
 * Database, seeded geography, profiles, the collection pipeline, health, operations, and the
 * JSON API the browser UI reads.
 *
 * SchedulerService drives each cycle at a jittered 15–35 minute gap; set CYCLE_ENABLED=false to run the
 * service without polling and drive cycles by hand instead. SourceRegistry owns the source
 * instances for the life of the process, which is what keeps a rate limiter's open circuit from
 * being forgotten between cycles.
 *
 * The UI API is registered here rather than in a module of its own because it reads through
 * PipelineService, ProfilesService, GeoService and OperationsService — all providers of this
 * module — and a separate module would have to import this one to reach them, which is a cycle.
 * `OperationsController` set the precedent.
 */
@Module({
  imports: [DbModule, ScheduleModule.forRoot()],
  controllers: [HealthController, OperationsController, ListingsViewController],
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
    ListingsViewRepository,
    ListingsViewService,
    UiAuthGuard,
    // Read at request time, not at boot: the guard's whole rule is "unset means closed", and
    // it has to be able to say so on every request rather than crash the process at startup.
    { provide: UI_TOKEN_SOURCE, useValue: (): string | undefined => loadEnv().UI_TOKEN },
  ],
  exports: [GeoService, ProfilesService, PipelineService, ProbeService, RentSafeService],
})
export class AppModule {}
