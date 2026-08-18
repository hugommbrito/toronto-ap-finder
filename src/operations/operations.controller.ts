import { Controller, ForbiddenException, Get, Headers, Query, ServiceUnavailableException } from '@nestjs/common';
import { loadEnv } from '@/config/env';
import { OperationsService, type OperationsReport } from './operations.service';

const DEFAULT_WINDOW_HOURS = 24;
const MAX_WINDOW_HOURS = 24 * 30;

/**
 * A summary of what worked and what did not, pullable straight from the deployment.
 *
 * Separate from `/health` on purpose, and the split is not cosmetic. `/health` is Railway's
 * `healthcheckPath`: it has to stay fast, unauthenticated, and answer only "is this process up".
 * This answers "has the work been getting done", which needs the database, a time window, and
 * authentication — because it exposes the shape of a private search.
 */
@Controller('operations')
export class OperationsController {
  constructor(private readonly operations: OperationsService) {}

  @Get()
  async report(
    @Headers('authorization') authorization: string | undefined,
    @Query('hours') hours?: string,
  ): Promise<OperationsReport> {
    this.authorize(authorization);
    return this.operations.report(windowHours(hours));
  }

  /**
   * Refuses rather than degrading when unconfigured.
   *
   * The README's own terms are personal use with no public exposure of the service, and this
   * route lists addresses, prices and failure detail. An unset token is a deployment that has not
   * decided yet — serving it openly "for convenience" is how a private search becomes a public
   * one, so an unset token closes the route instead of opening it.
   */
  private authorize(authorization: string | undefined): void {
    const token = loadEnv().OPERATIONS_TOKEN;
    if (!token) {
      throw new ServiceUnavailableException('OPERATIONS_TOKEN is not set; this route stays closed until it is');
    }
    const offered = authorization?.startsWith('Bearer ') ? authorization.slice(7) : null;
    if (offered !== token) throw new ForbiddenException('bad or missing bearer token');
  }
}

/** Clamped rather than rejected: a silly `?hours=` should still answer, over a sane window. */
export function windowHours(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_WINDOW_HOURS;
  return Math.min(Math.ceil(n), MAX_WINDOW_HOURS);
}
