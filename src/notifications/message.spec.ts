import { describe, expect, it } from 'vitest';
import { buildMessage, escapeHtml, overviewMapUrl, walkingRouteUrl, MAX_MAP_STOPS } from './message';
import type { NotificationPayload } from './notification.types';
import { inQuietHours } from '@/pipeline/pipeline.service';
import { buildSisterProfile } from '@/seed/sister-profile';
import type { TenantProfile } from '@/profiles/profile.schema';

function payload(overrides: Partial<NotificationPayload> = {}): NotificationPayload {
  return {
    listingId: 'uuid-1',
    fingerprint: 'abc123def456',
    profileId: 'sister',
    chatIds: ['1'],
    listing: {
      source: 'kijiji',
      sourceId: '1739230079',
      url: 'https://www.kijiji.ca/v-apartments-condos/city-of-toronto/x/1739230079',
      title: '3 Bedroom Apartment near Eglinton',
      rawText: 'body',
      rentBase: 2750,
      parkingIncluded: false,
      parkingCost: 150,
      utilitiesIncluded: ['heat', 'water'],
      totalMonthlyCost: 2900,
      beds: 3,
      dens: 0,
      baths: 2,
      hasLocker: true,
      inSuiteLaundry: true,
      address: '2770 Jane Street, Toronto, ON',
      city: 'City of Toronto',
      lat: 43.7474,
      lng: -79.51596,
      availableFrom: null,
      postedAt: null,
      buildingBuiltBefore2018: true,
    },
    score: {
      score: 78.2,
      breakdown: { bedroomFit: 25, rentBelowTarget: 12.9, transitOperational: 10.7 },
      rawComponents: { bedroomFit: 1, rentBelowTarget: 0.6, transitOperational: 1 },
      skipped: [],
    },
    reachableLines: [
      { line: 'Line 5 Eglinton', station: 'Keelesdale', distanceM: 412, lat: 43.6889, lng: -79.4795 },
    ],
    transitRadiusM: 1200,
    daycaresNearby: { total: 3, cwelcc: 2, radiusM: 800, coverage: 'full' as const },
    nearestDaycare: {
      name: 'Keelesdale Park Child Care', distanceM: 310, cwelcc: true, lat: 43.688, lng: -79.478,
    },
    mapStops: [
      { label: 'Keelesdale', lat: 43.6889, lng: -79.4795 },
      { label: 'Keelesdale Park Child Care', lat: 43.688, lng: -79.478 },
      { label: 'Rockcliffe Child Care', lat: 43.6871, lng: -79.4802 },
    ],
    includeMap: true,
    unverified: [],
    ...overrides,
  };
}

describe('escapeHtml', () => {
  it('escapes the characters Telegram would read as markup', () => {
    expect(escapeHtml('Queen & King <b>x</b>')).toBe('Queen &amp; King &lt;b&gt;x&lt;/b&gt;');
  });
});

describe('buildMessage', () => {
  it('leads with the score and the total cost', () => {
    const msg = buildMessage(payload());
    expect(msg).toContain('<b>78</b>');
    expect(msg).toContain('<b>CAD 2,900</b>/month');
  });

  it('shows how the total was reached, so paid parking is never hidden', () => {
    const msg = buildMessage(payload());
    expect(msg).toContain('base 2,750');
    expect(msg).toContain('+ parking 150');
  });

  it('always carries the score breakdown — the calibration instrument', () => {
    const msg = buildMessage(payload());
    expect(msg).toContain('bedroomFit');
    expect(msg).toContain('rentBelowTarget');
    expect(msg).toContain('<code>');
  });

  it('reports the reachable line, its station and a walking time', () => {
    const msg = buildMessage(payload());
    expect(msg).toContain('Line 5 Eglinton — Keelesdale, 412 m (~5 min)');
  });

  it('lists every reachable line, closest first', () => {
    const msg = buildMessage(
      payload({
        reachableLines: [
          { line: 'Line 4 Sheppard', station: 'Bayview', distanceM: 360, lat: 43.7671, lng: -79.3866 },
          { line: 'Line 1 Yonge-University', station: 'Sheppard-Yonge', distanceM: 640, lat: 43.7615, lng: -79.4111 },
        ],
      }),
    );
    expect(msg).toContain('Line 4 Sheppard — Bayview, 360 m (~5 min)');
    expect(msg).toContain('Line 1 Yonge-University — Sheppard-Yonge, 640 m (~8 min)');
    expect(msg.indexOf('Line 4')).toBeLessThan(msg.indexOf('Line 1'));
  });

  it('says plainly when there is no rapid transit at all', () => {
    // Liberty Village scored 76 and was notified with an empty transit ring. The breakdown
    // said transitOperational 0.0, which is easy to skim past; this is not.
    const msg = buildMessage(payload({ reachableLines: [], transitRadiusM: 1200 }));
    expect(msg).toContain('no subway or LRT within 1200 m');
  });

  it('names the childcare that actually counts', () => {
    const msg = buildMessage(payload());
    expect(msg).toContain('3 toddler daycares within 800 m — 2 with CWELCC');
    // A count is not an address: name the one she would actually walk to.
    expect(msg).toContain('closest: Keelesdale Park Child Care — 310 m, ~4 min · CWELCC');
  });

  it('omits the closest-daycare line when there is none in range', () => {
    expect(buildMessage(payload({ nearestDaycare: null }))).not.toContain('closest:');
  });

  it('does not tag a non-CWELCC centre as one', () => {
    const msg = buildMessage(
      payload({
        nearestDaycare: { name: 'Some Centre', distanceM: 200, cwelcc: false, lat: 43.7, lng: -79.4 },
      }),
    );
    expect(msg).toContain('closest: Some Centre');
    expect(msg).not.toContain('Some Centre — 200 m, ~3 min · CWELCC');
  });

  it('flags what the ad never stated instead of hiding it', () => {
    const msg = buildMessage(
      payload({ unverified: [{ field: 'parkingIncluded', reason: 'ad does not mention parking' }] }),
    );
    expect(msg).toContain('not stated in the ad');
    expect(msg).toContain('parkingIncluded');
  });

  it('escapes a hostile title rather than letting it break the markup', () => {
    const p = payload();
    p.listing.title = 'Great <b>deal</b> & more';
    const msg = buildMessage(p);
    expect(msg).toContain('Great &lt;b&gt;deal&lt;/b&gt; &amp; more');
  });

  it('describes a den layout correctly', () => {
    const p = payload();
    p.listing.beds = 2;
    p.listing.dens = 1;
    expect(buildMessage(p)).toContain('2 beds + den');
  });
});

describe('walking route links', () => {
  it('links a free Google Maps walking route to the nearest station', () => {
    const msg = buildMessage(payload());
    expect(msg).toContain('travelmode=walking');
    // Origin is the listing, destination the station — not the other way round.
    expect(msg).toContain('origin=43.7474%2C-79.51596&destination=43.6889%2C-79.4795');
  });

  it('links one to the closest daycare too', () => {
    expect(buildMessage(payload())).toContain('destination=43.688%2C-79.478');
  });

  it('omits the links when the listing has no coordinates', () => {
    const p = payload();
    p.listing.lat = null;
    p.listing.lng = null;
    expect(buildMessage(p)).not.toContain('travelmode=walking');
  });
});

describe('overview map link', () => {
  it('puts every nearby point on one map, as a round trip from the listing', () => {
    const msg = buildMessage(payload());
    expect(msg).toContain('map of the area');
    // Origin and destination are the listing: the route is beside the point, the pins are not.
    expect(msg).toContain('origin=43.7474%2C-79.51596&destination=43.7474%2C-79.51596');
    expect(msg).toContain('waypoints=43.6889%2C-79.4795%7C43.688%2C-79.478%7C43.6871%2C-79.4802');
  });

  it('never asks for more waypoints than a phone will render', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ label: `p${i}`, lat: 43.7 + i / 1000, lng: -79.4 }));
    const url = overviewMapUrl({ lat: 43.7, lng: -79.4 }, many);
    // Three is the mobile-browser cap; more produces a link that breaks where it is used.
    expect(url!.split('%7C')).toHaveLength(MAX_MAP_STOPS);
  });

  it('omits the link entirely when there is nothing to plot', () => {
    expect(overviewMapUrl({ lat: 43.7, lng: -79.4 }, [])).toBeNull();
    expect(buildMessage(payload({ mapStops: [] }))).not.toContain('map of the area');
  });
});

describe('walkingRouteUrl', () => {
  it('builds the documented, key-free Maps URLs form', () => {
    const url = walkingRouteUrl({ lat: 43.7, lng: -79.4 }, { lat: 43.71, lng: -79.41 });
    expect(url).toBe(
      'https://www.google.com/maps/dir/?api=1&origin=43.7%2C-79.4&destination=43.71%2C-79.41&travelmode=walking',
    );
    // api=1 is mandatory; commas must be encoded.
    expect(url).toContain('api=1');
    expect(url).not.toMatch(/origin=[^&]*,/);
  });
});

describe('inQuietHours', () => {
  const profile: TenantProfile = buildSisterProfile(['1']);

  /** 22:00-07:00 Toronto. Dates below are chosen to land either side of that. */
  const at = (isoUtc: string): boolean => inQuietHours(profile, new Date(isoUtc));

  it('is quiet late at night', () => {
    // 2026-08-18T03:00Z is 23:00 on the 17th in Toronto (EDT, UTC-4).
    expect(at('2026-08-18T03:00:00Z')).toBe(true);
  });

  it('is quiet in the small hours', () => {
    // 09:00Z = 05:00 Toronto.
    expect(at('2026-08-18T09:00:00Z')).toBe(true);
  });

  it('is not quiet during the day', () => {
    // 18:00Z = 14:00 Toronto.
    expect(at('2026-08-18T18:00:00Z')).toBe(false);
  });

  it('is never quiet for a profile that set no window', () => {
    const always: TenantProfile = { ...profile, notify: { ...profile.notify, quietHours: undefined } };
    expect(inQuietHours(always, new Date('2026-08-18T03:00:00Z'))).toBe(false);
  });
});

/**
 * What the reader is told when the childcare check could not actually be completed.
 *
 * This is the last place the coverage work can be undone. A Mississauga ad passes the childcare
 * filter on presence alone, so a message repeating Toronto's phrasing — "3 toddler daycares,
 * 2 with CWELCC" — would state two things nobody measured.
 */
describe('childcare line where the region publishes no age breakdown', () => {
  const unverified = () =>
    buildMessage(
      payload({ daycaresNearby: { total: 3, cwelcc: 0, radiusM: 800, coverage: 'presenceOnly' as const } }),
    );

  it('says licensed rather than toddler', () => {
    expect(unverified()).toContain('3 licensed daycares within 800 m');
    expect(unverified()).not.toContain('toddler daycares');
  });

  it('tells the reader to confirm, and never reports CWELCC as zero', () => {
    const text = unverified();
    expect(text).toMatch(/not published for this region/);
    expect(text).toMatch(/confirm before viewing/);
    expect(text).not.toContain('0 with CWELCC');
  });

  /**
   * The case that must never print a count. Nothing was searched, so "0 daycares within 800 m"
   * would assert a result nobody measured — the exact failure the coverage work exists to stop.
   */
  it('states that nothing was checked where no dataset reaches', () => {
    const text = buildMessage(
      payload({ daycaresNearby: { total: 0, cwelcc: 0, radiusM: 800, coverage: 'none' as const } }),
    );
    expect(text).toContain('no childcare data covers this area');
    expect(text).not.toMatch(/0 (?:toddler|licensed) daycare/);
  });

  it('leaves the Toronto wording untouched', () => {
    const text = buildMessage(payload());
    expect(text).toContain('3 toddler daycares within 800 m — 2 with CWELCC');
    expect(text).not.toMatch(/confirm before viewing/);
  });
});
