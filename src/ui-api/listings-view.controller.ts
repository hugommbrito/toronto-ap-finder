import { Body, Controller, Get, NotFoundException, Param, Put, Query, UseGuards } from '@nestjs/common';
import { windowHours } from '@/operations/operations.controller';
import type { OperationsReport } from '@/operations/operations.service';
import type { FeedPage, GeoOverview, ListingDetail, ListingState, MapSet, ProfileSummary, Summary } from './api-types';
import {
  feedQuerySchema,
  listingIdSchema,
  mapQuerySchema,
  parseOrBadRequest,
  profileQuerySchema,
  stateUpdateSchema,
} from './feed-query';
import { ListingsViewService } from './listings-view.service';
import { UiAuthGuard } from './ui-auth.guard';

/**
 * The JSON the browser UI reads. Every route sits behind `UiAuthGuard`, so an unset `UI_TOKEN`
 * closes all of it at once, and the guard is the only place that rule is written.
 *
 * Scores are per (listing, profile), so every route that names a listing also names a profile —
 * there is no such thing as a listing's score on its own.
 */
@Controller('api')
@UseGuards(UiAuthGuard)
export class ListingsViewController {
  constructor(private readonly view: ListingsViewService) {}

  @Get('profiles')
  profiles(): Promise<ProfileSummary[]> {
    return this.view.profiles();
  }

  @Get('listings')
  listings(@Query() query: Record<string, unknown>): Promise<FeedPage> {
    return this.view.feed(parseOrBadRequest(feedQuerySchema, query));
  }

  @Get('listings/:id')
  listing(@Param('id') id: string, @Query() query: Record<string, unknown>): Promise<ListingDetail> {
    const { profile } = parseOrBadRequest(profileQuerySchema, query);
    return this.view.detail(listingId(id), profile);
  }

  /**
   * The feed's narrowing, drawn: every located match up to the cap, with its surroundings. Not
   * under `listings/` on purpose — Nest matches routes in declaration order, and `listings/map`
   * declared after `listings/:id` would be read as an id.
   */
  @Get('map')
  map(@Query() query: Record<string, unknown>): Promise<MapSet> {
    return this.view.map(parseOrBadRequest(mapQuerySchema, query));
  }

  /** The layers under the map: every station, every daycare, and the profile's refused outlines. */
  @Get('geo')
  geo(@Query() query: Record<string, unknown>): Promise<GeoOverview> {
    const { profile } = parseOrBadRequest(profileQuerySchema, query);
    return this.view.geoOverview(profile);
  }

  @Get('summary')
  summary(@Query() query: Record<string, unknown>): Promise<Summary> {
    const { profile } = parseOrBadRequest(profileQuerySchema, query);
    return this.view.summary(profile);
  }

  @Put('listings/:id/state')
  state(
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ListingState> {
    const { profile } = parseOrBadRequest(profileQuerySchema, query);
    return this.view.updateState(listingId(id), profile, parseOrBadRequest(stateUpdateSchema, body));
  }

  /** The operations report, for the funnel tab. Same window rules as GET /operations. */
  @Get('funnel')
  funnel(@Query('hours') hours?: string): Promise<OperationsReport> {
    return this.view.funnel(windowHours(hours));
  }
}

/** A malformed id cannot name a row, so it is a 404 rather than a database error about uuids. */
function listingId(raw: string): string {
  const parsed = listingIdSchema.safeParse(raw);
  if (!parsed.success) throw new NotFoundException(`no listing ${raw}`);
  return parsed.data;
}
