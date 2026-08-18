import { describe, expect, it } from 'vitest';
import { buildMessage, escapeHtml } from './message';
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
    reachableLines: [{ line: 'Line 5 Eglinton', station: 'Keelesdale', distanceM: 412 }],
    transitRadiusM: 1200,
    daycaresNearby: { total: 3, cwelcc: 2, radiusM: 800 },
    nearestDaycare: { name: 'Keelesdale Park Child Care', distanceM: 310, cwelcc: true },
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
          { line: 'Line 4 Sheppard', station: 'Bayview', distanceM: 360 },
          { line: 'Line 1 Yonge-University', station: 'Sheppard-Yonge', distanceM: 640 },
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
      payload({ nearestDaycare: { name: 'Some Centre', distanceM: 200, cwelcc: false } }),
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
