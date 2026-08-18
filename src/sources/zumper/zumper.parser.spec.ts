import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildSearchUrl,
  extractStateArray,
  parseBuildingPage,
  parseSearchPage,
  ZumperParseError,
} from './zumper.parser';
import type { BuildingEntry } from '../source.interface';

/** Real payloads captured from Zumper on 2026-08-18, trimmed to a spread of layouts. */
const html = (name: string): string =>
  readFileSync(resolve(`test/fixtures/zumper/${name}.html`), 'utf8');

const SEARCH = html('search-page');
const BUILDING = html('building-page');

describe('extractStateArray', () => {
  const anyObject = (i: unknown): boolean => typeof i === 'object' && i !== null;

  it('pulls an array out of a script that is not itself JSON', () => {
    // The whole page state is a JavaScript literal; only the array can be parsed.
    const page = '<script>var x = 1; window.S = {"listables":[{"listing_id":7}]};</script>';
    expect(extractStateArray(page, 'listables', anyObject)).toEqual([{ listing_id: 7 }]);
  });

  it('walks past the empty decoys that share the key name', () => {
    // The real search page holds sixteen keys named "listables"; the first ones belong to
    // the affordability calculator and the agent profile and are empty. Returning the first
    // one that parses reports a city with no rentals in it.
    const page =
      '<script>{"affordabilityCalculator":{"listables":[]},"agentProfile":{"listables":[]},' +
      '"search":{"listables":{"featured":[],"listables":[{"listing_id":7,"lat":43.6}]}}}</script>';
    const found = extractStateArray(page, 'listables', (i) => anyObject(i) && 'lat' in (i as object));
    expect(found).toEqual([{ listing_id: 7, lat: 43.6 }]);
  });

  it('does not stop at a bracket inside an advertisement body', () => {
    // A description containing "]" ended the array early before brackets were balanced
    // with string tracking.
    const page = '<script>{"units":[{"description":"Suite [B] is ] available","price":2000}]}</script>';
    const [unit] = extractStateArray(page, 'units', anyObject) as { description: string; price: number }[];
    expect(unit?.price).toBe(2000);
    expect(unit?.description).toBe('Suite [B] is ] available');
  });

  it('keeps looking when the first candidate key is not an array', () => {
    const page = '<script>{"units":null,"x":1,"units":[{"price":1}]}</script>';
    expect(extractStateArray(page, 'units', anyObject)).toHaveLength(1);
  });

  it('throws loudly when the key is absent', () => {
    // Silence here is indistinguishable from "no buildings in Toronto today".
    expect(() => extractStateArray('<html></html>', 'listables', anyObject)).toThrow(ZumperParseError);
  });
});

describe('parseSearchPage', () => {
  const page = parseSearchPage(SEARCH);

  it('reads the buildings the page listed', () => {
    expect(page.buildings.length).toBeGreaterThanOrEqual(5);
  });

  it('returns buildings, not listings — nothing here carries a single price', () => {
    // The distinction this source turns on: a search result is a range over many floorplans.
    const ranged = page.buildings.filter((b) => b.minPrice !== b.maxPrice);
    expect(ranged.length).toBe(page.buildings.length);
    for (const b of page.buildings) expect(b.floorplanCount).toBeGreaterThan(0);
  });

  it('keeps the coordinates, which every unit inside will inherit', () => {
    for (const b of page.buildings) {
      expect(b.lat!).toBeGreaterThan(43);
      expect(b.lat!).toBeLessThan(44);
      expect(b.lng!).toBeLessThan(-79);
    }
  });

  it('sets aside a building with no coordinates instead of dropping it', () => {
    // It cannot be measured against daycares or transit, but it belongs in the count.
    expect(page.unparsable.some((u) => u.reason === 'building has no coordinates')).toBe(true);
  });

  it('reads the modified_on watermark, which is what makes a full sweep affordable', () => {
    const withWatermark = page.buildings.filter((b) => b.modifiedOn !== null);
    expect(withWatermark.length).toBe(page.buildings.length);
    for (const b of withWatermark) {
      // Seconds, not milliseconds: reading them as ms lands in 1970.
      expect(b.modifiedOn!.getFullYear()).toBeGreaterThan(2020);
    }
  });

  it('reports the city-wide total, not the page size', () => {
    expect(page.pagination.totalCount).toBeGreaterThan(100);
  });

  it('throws when the page lists nothing at all', () => {
    // Silence and "no rentals in Toronto" must never look the same.
    expect(() => parseSearchPage('<script>{"listables":[]}</script>')).toThrow(ZumperParseError);
  });
});

const building: BuildingEntry = {
  sourceId: '60865974',
  url: 'https://www.zumper.com/apartment-buildings/p1624543/the-diamond',
  name: 'The Diamond',
  address: '950 Lansdowne Ave',
  city: 'Toronto',
  lat: 43.6695,
  lng: -79.4477,
  minPrice: 2169,
  maxPrice: 3809,
  minBedrooms: 1,
  maxBedrooms: 3,
  floorplanCount: 28,
  modifiedOn: new Date('2026-08-17'),
  amenityTags: ['Garage Parking', 'Storage'],
};

describe('parseBuildingPage', () => {
  const units = parseBuildingPage(BUILDING, building);

  it('turns one request into many listings', () => {
    // The inverse of Kijiji, where one request yields one listing.
    expect(units.length).toBeGreaterThanOrEqual(8);
  });

  it('gives every unit its own price and layout', () => {
    for (const u of units) {
      expect(u.rentBase).toBeGreaterThan(400);
      expect(u.beds === null || Number.isInteger(u.beds)).toBe(true);
    }
    const beds = new Set(units.map((u) => u.beds));
    expect(beds.size).toBeGreaterThan(1);
  });

  it('skips a floorplan with no price rather than scoring it as free', () => {
    const ids = units.map((u) => u.sourceId);
    expect(ids).not.toContain('99999002');
  });

  it('inherits the building coordinates — a floorplan has none of its own', () => {
    for (const u of units) {
      expect(u.lat).toBe(building.lat);
      expect(u.lng).toBe(building.lng);
      expect(u.address).toBe(building.address);
    }
  });

  it('reads parking from the building amenity list, the only structured statement of it', () => {
    for (const u of units) expect(u.parkingIncluded).toBe(true);
  });

  it('never claims a den from structured data — Zumper has no such field', () => {
    // A den can only come from the description, through the enrichment stage.
    for (const u of units) expect(u.dens).toBe(0);
  });

  it('leaves an unmentioned amenity null rather than false', () => {
    const noLaundry = parseBuildingPage(BUILDING, { ...building, amenityTags: [] });
    for (const u of noLaundry) {
      expect(u.parkingIncluded === true || u.parkingIncluded === null).toBe(true);
      expect(u.hasLocker === true || u.hasLocker === null).toBe(true);
    }
  });

  it('counts half bathrooms as halves', () => {
    for (const u of units) {
      if (u.baths !== null) expect(u.baths % 0.5).toBe(0);
    }
  });

  it('records the absence of an advertisement body rather than inventing one', () => {
    // Zumper publishes no prose: description and short_description were empty for all 38
    // floorplans of a real building. A null rawText is the fact; anything else would send
    // the verifier off to read a page that does not exist.
    for (const u of units) expect(u.rawText).toBeNull();
  });

  it('names the unit so a notification is readable', () => {
    for (const u of units) expect(u.title).toContain('The Diamond');
  });
});

describe('buildSearchUrl', () => {
  it('uses the plural path, which robots.txt does not disallow', () => {
    // `/apartment-for-rent/` — singular — is disallowed; `/apartments-for-rent/` is not.
    expect(buildSearchUrl(1)).toBe('https://www.zumper.com/apartments-for-rent/toronto-on');
    expect(buildSearchUrl(1)).not.toContain('/apartment-for-rent/');
  });

  it('paginates with the only parameter robots.txt allows', () => {
    expect(buildSearchUrl(3)).toBe('https://www.zumper.com/apartments-for-rent/toronto-on?page=3');
    for (const banned of ['?s=', 'loc=', 'box=', 'bedrooms=', 'bathrooms=', 'listingId=']) {
      expect(buildSearchUrl(3)).not.toContain(banned);
    }
  });
});
