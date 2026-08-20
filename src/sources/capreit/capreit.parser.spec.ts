import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CapreitParseError,
  parseAvailability,
  parseBuildingPage,
  parseBuildingRecord,
  parseLayout,
  parsePrice,
  parseSitemap,
  toBuildingEntry,
} from './capreit.parser';

const fixture = (name: string): string =>
  readFileSync(resolve(`test/fixtures/capreit/${name}.html`), 'utf8');

const wellesley = fixture('wellesley-apartments');
const roanoke = fixture('roanoke-apartments');
const scarborough = fixture('scarborough-golf-apartments');

describe('entity decoding', () => {
  it('decodes entities that otherwise reach the database verbatim', () => {
    // One building came through with a city of "190 &amp; 200 Kingsview".
    const html = `<script type="application/ld+json">${JSON.stringify({
      '@type': 'Apartment',
      name: 'Kingsview &amp; Something',
      address: [{ streetAddress: '190 &amp; 200 Kingsview Blvd', addressLocality: 'Toronto', postalCode: 'M9N 1L1' }],
    })}</script><ul class="property-options-list"></ul>`;
    const b = parseBuildingRecord(html);
    expect(b.name).toBe('Kingsview & Something');
    expect(b.address).toBe('190 & 200 Kingsview Blvd');
    expect(b.city).toBe('Toronto');
  });
});

describe('parseLayout', () => {
  it('reads the den CAPREIT declares, which no other source here does', () => {
    expect(parseLayout('2 Bedroom + Den')).toEqual({ beds: 2, dens: 1 });
    expect(parseLayout('1 Bedroom + Den')).toEqual({ beds: 1, dens: 1 });
    expect(parseLayout('3 Bedroom')).toEqual({ beds: 3, dens: 0 });
  });

  it('treats a bachelor as zero bedrooms rather than as unknown', () => {
    expect(parseLayout('Bachelor')).toEqual({ beds: 0, dens: 0 });
    expect(parseLayout('Studio')).toEqual({ beds: 0, dens: 0 });
  });

  it('returns null for a label it cannot read, instead of guessing', () => {
    expect(parseLayout('Penthouse')).toBeNull();
    expect(parseLayout('')).toBeNull();
  });
});

describe('parsePrice', () => {
  it('takes the bottom of a range, which is what "starting at" means', () => {
    expect(parsePrice('Starting at $1,605 - $1,690')).toBe(1605);
    expect(parsePrice('Starting at $2,190')).toBe(2190);
  });

  it('is null when there is no price at all', () => {
    expect(parsePrice('No Vacancies')).toBeNull();
    expect(parsePrice('')).toBeNull();
  });
});

describe('parseAvailability', () => {
  it('leaves immediate availability null rather than inventing today', () => {
    // The profile reads null as "as soon as possible", which is exactly what this means. A date
    // would be stale tomorrow.
    expect(parseAvailability('Available Immediately')).toBeNull();
  });

  it('reads a real date', () => {
    expect(parseAvailability('Available September 1, 2026')).toBe('2026-09-01');
    expect(parseAvailability('Available October 1, 2026')).toBe('2026-10-01');
  });
});

describe('parseBuildingRecord', () => {
  it('reads the building out of JSON-LD, whitespace and all', () => {
    const b = parseBuildingRecord(wellesley);
    expect(b.name).toBe('Wellesley Apartments');
    expect(b.address).toBe('100 Wellesley Street East');
    // The page's own indentation lives inside these strings.
    expect(b.city).toBe('Toronto');
    expect(b.description).toMatch(/apartments for rent in Toronto/i);
  });

  it('reads a compound address whose JSON-LD fields are shifted', () => {
    // "7 & 9 Roanoke Road, North York, ON, M3A 1E3" arrives as streetAddress '7',
    // addressLocality '9 Roanoke Road', addressRegion 'North York', postalCode 'ON, M3A 1E3'.
    // Trusting addressLocality put a street into the city column for eleven of eighty-two units,
    // and the city filter then rejected every one of them for a reason that was ours.
    const b = parseBuildingRecord(roanoke);
    expect(b.city).toBe('North York');
    expect(b.address).toBe('9 Roanoke Road');
  });

  it('still reads an address whose fields are correctly aligned', () => {
    const b = parseBuildingRecord(wellesley);
    expect(b.city).toBe('Toronto');
    expect(b.address).toBe('100 Wellesley Street East');
  });

  it('coerces the coordinates, which arrive as strings', () => {
    const b = parseBuildingRecord(wellesley);
    expect(b.lat).toBeCloseTo(43.666223, 5);
    expect(b.lng).toBeCloseTo(-79.378614, 5);
    expect(typeof b.lat).toBe('number');
  });

  it('throws loudly when the record is gone', () => {
    expect(() => parseBuildingRecord('<html><body>nothing</body></html>')).toThrow(CapreitParseError);
    expect(() => parseBuildingRecord('<script type="application/ld+json">{"@type":"WebPage"}</script>')).toThrow(
      /no Apartment record/,
    );
  });
});

describe('parseBuildingPage', () => {
  it('emits one listing per available unit type, with the den kept', () => {
    const units = parseBuildingPage(wellesley);
    expect(units.map((u) => `${u.beds}+${u.dens} $${u.rentBase}`)).toEqual([
      '0+0 $1605',
      '1+0 $1995',
      '1+1 $2190',
      '2+0 $2550',
    ]);
  });

  it('refuses a unit type the building has but cannot rent', () => {
    // The correction that mattered: a page lists what the building contains, not what is
    // available. Roanoke advertises a 2BR+Den and a 3BR, both "No Vacancies" with no price.
    // Emitting them would fill the feed with apartments nobody can take — and they would score
    // well, because the bedroom count is real and only the availability is not.
    const units = parseBuildingPage(roanoke);
    expect(units.map((u) => `${u.beds}+${u.dens}`)).toEqual(['1+0', '2+0']);
    expect(units.some((u) => u.beds === 3)).toBe(false);
  });

  it('keeps the available three-bedroom, which is the case this source exists for', () => {
    const units = parseBuildingPage(scarborough);
    const three = units.find((u) => u.beds === 3);
    expect(three).toBeDefined();
    expect(three!.rentBase).toBe(2910);
    expect(three!.availableFrom).toBe('2026-10-01');
  });

  it('gives every unit the building it is in', () => {
    for (const unit of parseBuildingPage(wellesley)) {
      expect(unit.source).toBe('capreit');
      expect(unit.address).toBe('100 Wellesley Street East');
      expect(unit.lat).toBeCloseTo(43.666223, 5);
      expect(unit.url).toContain('/wellesley-apartments/');
      expect(unit.title).toContain('Wellesley Apartments');
    }
  });

  it('mints an id that survives a price change but distinguishes the layouts', () => {
    const ids = parseBuildingPage(wellesley).map((u) => u.sourceId);
    expect(ids).toEqual([
      'wellesley-apartments:0br',
      'wellesley-apartments:1br',
      'wellesley-apartments:1br-den',
      'wellesley-apartments:2br',
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('never reads an asterisked amenity as a promise', () => {
    // CAPREIT writes `Parking*` and `Storage*` and never says what the asterisk qualifies.
    // Turning that into `true` would be resolving someone else's disclaimer in our own favour.
    const [unit] = parseBuildingPage(wellesley);
    expect(parseBuildingRecord(wellesley).amenities.some((a) => a.startsWith('Parking'))).toBe(true);
    expect(unit!.parkingIncluded).toBeNull();
    expect(unit!.hasLocker).toBeNull();
  });

  it('does not mistake a bike room for a storage locker', () => {
    // Wellesley lists an asterisked `Storage*` and an unasterisked `Bicycle Storage`. A plain
    // search for "storage" reads the second as a locker and awards the credit to every building
    // with somewhere to put a bicycle — small per listing, systematic across all of them.
    const amenities = parseBuildingRecord(wellesley).amenities;
    expect(amenities.some((a) => /bicycle storage/i.test(a))).toBe(true);
    expect(parseBuildingPage(wellesley)[0]!.hasLocker).toBeNull();
  });

  it('reads an unqualified utility as included', () => {
    // `Water Included` carries no asterisk, so it is a plain statement.
    expect(parseBuildingPage(wellesley)[0]!.utilitiesIncluded).toContain('water');
  });

  it('leaves unknown fields unknown rather than false', () => {
    const [unit] = parseBuildingPage(wellesley);
    expect(unit!.baths).toBeNull();
    expect(unit!.postedAt).toBeNull();
    expect(unit!.buildingBuiltBefore2018).toBeNull();
  });

  it('throws rather than returning nothing when the page shape changes', () => {
    // A silent empty result is indistinguishable from a building with nothing to rent, which is
    // how a source dies unnoticed.
    expect(() => parseBuildingPage('<html><body>redesigned</body></html>')).toThrow(/no unit list/);
  });

  it('throws when a second unit list appears', () => {
    // Twelve measured pages carried exactly one. Zumper's sixteen decoy `listables` keys are the
    // precedent for what taking the first match of a repeated name costs.
    const doubled = wellesley.replace('</body>', '<ul class="property-options-list"></ul></body>');
    expect(() => parseBuildingPage(doubled)).toThrow(/expected one unit list, found 2/);
  });
});

describe('parseSitemap', () => {
  const xml = `<?xml version="1.0"?><urlset>
    <url><loc>https://www.capreit.ca/apartments-for-rent/toronto-on/wellesley-apartments/</loc>
      <lastmod>2026-08-18T13:32:52-04:00</lastmod></url>
    <url><loc>https://www.capreit.ca/fr/appartements-a-louer/toronto-on/wellesley-apartments/</loc>
      <lastmod>2026-08-18T13:32:52-04:00</lastmod></url>
    <url><loc>https://www.capreit.ca/apartments-for-rent/montreal-qc/the-onyx/</loc>
      <lastmod>2026-08-18T13:32:16-04:00</lastmod></url>
    <url><loc>https://www.capreit.ca/apartments-for-rent/north-york-on/don-view-towers/</loc></url>
  </urlset>`;

  it('keeps the profile’s cities and drops the rest of the country', () => {
    expect(parseSitemap(xml).map((e) => e.slug)).toEqual(['wellesley-apartments', 'don-view-towers']);
  });

  it('drops the French tree, which duplicates every property', () => {
    expect(parseSitemap(xml).filter((e) => e.url.includes('/fr/'))).toEqual([]);
  });

  it('reads lastmod, which is the watermark that makes a sweep affordable', () => {
    const [first] = parseSitemap(xml);
    expect(first!.lastModified?.toISOString()).toBe('2026-08-18T17:32:52.000Z');
  });

  it('tolerates a property with no lastmod rather than dropping it', () => {
    const withoutStamp = parseSitemap(xml).find((e) => e.slug === 'don-view-towers');
    expect(withoutStamp?.lastModified).toBeNull();
  });

  it('throws when the sitemap yields nothing at all', () => {
    expect(() => parseSitemap('<urlset></urlset>')).toThrow(/no property URLs/);
  });

  it('hands the building cycle the watermark it keys on', () => {
    const entry = toBuildingEntry(parseSitemap(xml)[0]!);
    expect(entry.sourceId).toBe('wellesley-apartments');
    expect(entry.modifiedOn?.toISOString()).toBe('2026-08-18T17:32:52.000Z');
    // The city segment is a routing convenience; the address on the page is the fact.
    expect(entry.city).toBeNull();
  });
});
