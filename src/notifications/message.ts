import type { NotificationPayload } from './notification.types';

/** Telegram HTML mode only allows a small tag set; everything else must be escaped. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function money(n: number): string {
  return n.toLocaleString('en-CA', { maximumFractionDigits: 0 });
}

function layoutLabel(beds: number | null, dens: number): string {
  if (beds === null) return 'layout unknown';
  const bedPart = `${beds} bed${beds === 1 ? '' : 's'}`;
  return dens > 0 ? `${bedPart} + den` : bedPart;
}

/**
 * A Google Maps walking-route deep link, via the Maps URLs API.
 *
 * No API key and no billing account: the URL scheme is a documented, free product. It also
 * answers the question better than any image would — one tap gives the real route along real
 * streets and Google's own walking time, where a static picture could only show two dots and
 * the straight line this project estimates between them.
 */
export function walkingRouteUrl(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
): string {
  const origin = `${from.lat}%2C${from.lng}`;
  const destination = `${to.lat}%2C${to.lng}`;
  return `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}&travelmode=walking`;
}

/**
 * Google Maps caps waypoints at three on mobile browsers (nine elsewhere). The link is read
 * on a phone, so three is the real limit — asking for more produces a link that breaks in
 * exactly the place it is used.
 */
export const MAX_MAP_STOPS = 3;

/**
 * One map showing the listing and everything that matters around it.
 *
 * Built as a round trip — the listing is both origin and destination — because the route is
 * beside the point. What the reader wants is every pin on one map at once: how the daycares
 * and the station sit relative to the front door, which no list of distances conveys.
 */
export function overviewMapUrl(
  home: { lat: number; lng: number },
  stops: { lat: number; lng: number }[],
): string | null {
  const chosen = stops.slice(0, MAX_MAP_STOPS);
  if (chosen.length === 0) return null;
  const point = (p: { lat: number; lng: number }): string => `${p.lat}%2C${p.lng}`;
  const waypoints = chosen.map(point).join('%7C');
  return (
    `https://www.google.com/maps/dir/?api=1&origin=${point(home)}&destination=${point(home)}` +
    `&waypoints=${waypoints}&travelmode=walking`
  );
}

function walkMinutes(metres: number): number {
  // ~80 m/min is a normal walking pace; good enough to make a distance legible.
  return Math.max(1, Math.round(metres / 80));
}

/**
 * The message body.
 *
 * The score breakdown is not decoration — it is the instrument for calibrating the weights
 * in the first weeks, so it travels with every notification rather than living only in the
 * database.
 */
export function buildMessage(payload: NotificationPayload): string {
  const { listing, score } = payload;
  const lines: string[] = [];

  lines.push(
    `🏠 <b>${Math.round(score.score)}</b> · ${escapeHtml(listing.title.slice(0, 90))}`,
    '',
  );

  const parkingNote =
    listing.parkingIncluded === true
      ? 'parking included'
      : listing.parkingCost !== null
        ? `+ parking ${money(listing.parkingCost)}`
        : listing.parkingAvailable === true
          ? // Passes the parking requirement, but unlike a priced spot its cost is NOT in
            // the monthly total — the wording is what keeps that honest.
            'parking available (cost unstated)'
          : listing.parkingIncluded === false
            ? 'no parking'
            : 'parking not stated';
  lines.push(`<b>CAD ${money(listing.totalMonthlyCost)}</b>/month · base ${money(listing.rentBase)} · ${parkingNote}`);

  const features = [layoutLabel(listing.beds, listing.dens)];
  if (listing.areaSqft !== null) features.push(`${listing.areaSqft} sq ft`);
  if (listing.baths !== null) features.push(`${listing.baths} bath`);
  if (listing.hasLocker === true) features.push('locker');
  if (listing.inSuiteLaundry === true) features.push('in-suite laundry');
  lines.push(escapeHtml(features.join(' · ')));

  if (listing.utilitiesIncluded.length > 0) {
    lines.push(escapeHtml(`utilities included: ${listing.utilitiesIncluded.join(', ')}`));
  }
  lines.push('');

  if (listing.address) lines.push(`📍 ${escapeHtml(listing.address)}`);

  const here =
    listing.lat !== null && listing.lng !== null ? { lat: listing.lat, lng: listing.lng } : null;
  /** Distances in this message are estimates; the link is where the real number lives. */
  const route = (to: { lat: number; lng: number }): string =>
    here ? ` · <a href="${walkingRouteUrl(here, to)}">rota</a>` : '';

  if (payload.reachableLines.length === 0) {
    // The case worth shouting about: a listing can score well on everything else and still
    // have no rapid transit at all. Toronto streetcars are not in the index by design.
    lines.push(`🚇 no subway or LRT within ${payload.transitRadiusM} m`);
  } else {
    const [first, ...rest] = payload.reachableLines;
    lines.push(
      `🚇 ${escapeHtml(first!.line)} — ${escapeHtml(first!.station)}, ` +
        `${Math.round(first!.distanceM)} m (~${walkMinutes(first!.distanceM)} min)${route(first!)}`,
    );
    for (const l of rest) {
      lines.push(
        `    ${escapeHtml(l.line)} — ${escapeHtml(l.station)}, ` +
          `${Math.round(l.distanceM)} m (~${walkMinutes(l.distanceM)} min)${route(l)}`,
      );
    }
  }
  const { total, cwelcc, radiusM, coverage } = payload.daycaresNearby;
  if (coverage === 'full') {
    lines.push(`👶 ${total} toddler daycare${total === 1 ? '' : 's'} within ${radiusM} m — ${cwelcc} with CWELCC`);
  } else if (coverage === 'presenceOnly') {
    // Says "licensed", not "toddler", and names the gap rather than implying a zero. This is the
    // one line that tells the reader the childcare check could not actually be completed here.
    lines.push(
      `👶 ${total} licensed daycare${total === 1 ? '' : 's'} within ${radiusM} m — ` +
        'toddler places and CWELCC not published for this region, confirm before viewing',
    );
  } else {
    // Never "0 daycares nearby". Nothing was searched, so a count would be a claim.
    lines.push(`👶 no childcare data covers this area — nothing was checked within ${radiusM} m`);
  }
  if (payload.nearestDaycare) {
    const { name, distanceM, cwelcc: isCwelcc } = payload.nearestDaycare;
    const tag = isCwelcc ? ' · CWELCC' : '';
    lines.push(
      `    closest: ${escapeHtml(name)} — ${Math.round(distanceM)} m, ` +
        `~${walkMinutes(distanceM)} min${tag}${route(payload.nearestDaycare)}`,
    );
  }
  if (listing.buildingBuiltBefore2018 === true) lines.push('🏛 pre-2018 building — rent increases capped');
  lines.push('');

  const breakdown = Object.entries(score.breakdown)
    .sort(([, a], [, b]) => b - a)
    .map(([name, points]) => `${name.padEnd(20)}${points.toFixed(1).padStart(5)}`)
    .join('\n');
  lines.push(`<b>Score ${score.score.toFixed(1)}</b>`, `<code>${escapeHtml(breakdown)}</code>`);

  if (payload.unverified.length > 0) {
    const fields = payload.unverified.map((r) => r.field).join(', ');
    lines.push('', `⚠️ not stated in the ad: ${escapeHtml(fields)} — worth checking`);
  }

  const overview = here ? overviewMapUrl(here, payload.mapStops) : null;
  const links = [`<a href="${escapeHtml(listing.url)}">view listing</a>`];
  if (overview) links.push(`<a href="${overview}">map of the area</a>`);
  lines.push('', links.join('  ·  '));
  return lines.join('\n');
}
