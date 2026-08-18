import { describe, expect, it } from 'vitest';
import { normalizeText, htmlToText, toSearchableText } from './normalize';
import {
  extractBeds,
  extractBuiltBefore2018,
  extractDens,
  extractInSuiteLaundry,
  extractLocker,
  extractParking,
  extractUtilities,
} from './rules';

/**
 * Fixtures are verbatim ad text collected from Kijiji's Toronto rental category
 * (2026-08-17). Synthetic strings would only prove the regexes match themselves.
 */
const REAL = {
  luxuryCondo:
    'Brand New Luxury Condo | 2 Beds + Den | Corner Suite | Parking + Locker Included 2 Beds + Den Be the very first to call this stunning southwest-facing corner suite home! This brand new, never lived in unit...',
  donMills:
    'Beautiful bright 1 bdrm condo at Don Mills/Lawrence. 1 Parking, good layout, large balcony with great views of center square. Central air, ensuite laundry, laminate floors. Mins to major highways',
  basement3br:
    'Near by York University, Bus & Subway Station, Shopping Center and public park. Between Allen Rd .and Sheppard Ave W. Including: (1) 3 bed rooms (2) 1 Bath room (3) Laundry in unit (4) Kitchen room',
  beaches:
    'Available October 1. One bedroom apartment in the basement of a quiet home. 3 piece washroom with shower. On-site coin laundry. Non-smokers only. Approx 600 sq foot. $1590/month, includes heat',
  wilsonSubway:
    '$1475/month - ALL INCLUSIVE Private furnished bedroom + Private bathroom. No sharing! INCLUDES: - Heat, Hydro, Water, High-Speed WiFi - In-suite Laundry - Gym + Outdoor Pool - FREE - Queen Bed + TV',
  danforthCondo:
    'Brand new condo apartment with 2 bedrooms plus a den, 2 full washrooms and huge balcony. Home internet included.Located on danforth ave and Main Street. 2 mins walk from main st subway station.',
  esplanadeLoft:
    '1 bedroom loft with 20 Ft. ceilings, 1,200 Sq. Ft. one of a kind unit in one of the best buildings downtown Toronto - London on the Esplanade. Includes 1 parking spot located directly opposite the',
  islingtonBasement:
    '1 Bedroom basement apartment with separate walkout entrance completely private, location Islington/ Finch, includes private kitchen and bathroom and small living area, Utilities, Wifi and parking',
  distillerySublet:
    'Looking for someone to sublet my fully furnished 1 bedroom + den apartment in the distillery district downtown Toronto. Available starting Sept 1st, ideally for a minimum of 3 months (flexible) and',
};

const n = (s: string): string => normalizeText(s);

describe('htmlToText', () => {
  it('turns the Kijiji HTML body into readable lines', () => {
    // Shape taken from an actual detail-page description.
    const html =
      '<p><b>SUITE FEATURES:</b></p><ul><li>Large &amp; bright 1 bedroom apartment</li><li>Renovated suite</li></ul>';
    const text = htmlToText(html);
    expect(text).toContain('SUITE FEATURES:');
    expect(text).toContain('Large & bright 1 bedroom apartment');
    expect(text).toContain('Renovated suite');
  });

  it('keeps block boundaries so adjacent list items do not fuse into one phrase', () => {
    const text = htmlToText('<li>In-suite laundry</li><li>No parking</li>');
    // Without a boundary this would read as "laundry no parking" and confuse negation checks.
    expect(text).toMatch(/laundry\s*\n\s*No parking/i);
  });
});

describe('normalizeText', () => {
  it('keeps the punctuation the rules depend on', () => {
    expect(n('Parking $150/month')).toBe('parking $150/month');
    expect(n('2+1 unit')).toBe('2+1 unit');
    expect(n('1.5 baths')).toBe('1.5 baths');
  });

  it('strips accents and case', () => {
    expect(n('Montréal STYLE Loft')).toBe('montreal style loft');
  });

  it('drops emoji and decorative punctuation without joining words', () => {
    expect(n('Corner Suite | Parking + Locker')).toBe('corner suite parking + locker');
  });
});

describe('extractLocker', () => {
  it('finds a locker in the real "Parking + Locker Included" phrasing', () => {
    expect(extractLocker(n(REAL.luxuryCondo))).toBe(true);
  });

  it('finds the bare mention', () => {
    expect(extractLocker(n('Includes a storage locker on P2'))).toBe(true);
    expect(extractLocker(n('1 locker included'))).toBe(true);
  });

  it('honours an explicit denial', () => {
    expect(extractLocker(n('No locker available'))).toBe(false);
    expect(extractLocker(n('Locker not included'))).toBe(false);
  });

  it('returns null — never false — when the ad is silent', () => {
    expect(extractLocker(n(REAL.donMills))).toBeNull();
    expect(extractLocker(n(REAL.beaches))).toBeNull();
  });
});

describe('extractDens', () => {
  it('reads the real "+ Den" and "plus a den" phrasings', () => {
    expect(extractDens(n(REAL.luxuryCondo))).toBe(1);
    expect(extractDens(n(REAL.danforthCondo))).toBe(1);
    expect(extractDens(n(REAL.distillerySublet))).toBe(1);
  });

  it('reads the Toronto "2+1" shorthand', () => {
    expect(extractDens(n('Bright 2+1 suite near the subway'))).toBe(1);
  });

  it('honours an explicit denial', () => {
    expect(extractDens(n('2 bedroom, no den'))).toBe(0);
  });

  it('returns null when the ad is silent', () => {
    expect(extractDens(n(REAL.basement3br))).toBeNull();
  });
});

describe('extractBeds', () => {
  it('reads real bedroom phrasings', () => {
    expect(extractBeds(n(REAL.luxuryCondo))).toBe(2);
    expect(extractBeds(n(REAL.basement3br))).toBe(3);
    expect(extractBeds(n(REAL.donMills))).toBe(1);
  });

  it('treats bachelor and studio as zero bedrooms', () => {
    expect(extractBeds(n('Fully Furnished Bachelor Apartment for Sublet'))).toBe(0);
  });
});

describe('extractParking', () => {
  it('reads "Parking + Locker Included" as included at no extra cost', () => {
    expect(extractParking(n(REAL.luxuryCondo))).toEqual({ included: true, cost: null });
  });

  it('reads "Includes 1 parking spot" as included', () => {
    expect(extractParking(n(REAL.esplanadeLoft))).toEqual({ included: true, cost: null });
  });

  it('separates paid parking from included parking, and captures the price', () => {
    // This is the distinction that decides whether a 3,150 listing is really a 3,300 one.
    expect(extractParking(n('Parking available for $150/month'))).toEqual({ included: false, cost: 150 });
    expect(extractParking(n('Parking: $200 extra'))).toEqual({ included: false, cost: 200 });
  });

  it('honours an explicit denial', () => {
    expect(extractParking(n('No parking included with this unit'))).toEqual({ included: false, cost: null });
    expect(extractParking(n('Street parking only'))).toEqual({ included: false, cost: null });
  });

  it('leaves an ambiguous mention undetermined rather than guessing', () => {
    // "One parking is needed" is a tenant asking, not a landlord offering.
    expect(extractParking(n('Looking for a room. One parking is needed')).included).toBeNull();
  });
});

describe('extractInSuiteLaundry', () => {
  it('reads the real in-suite phrasings', () => {
    expect(extractInSuiteLaundry(n(REAL.donMills))).toBe(true);
    expect(extractInSuiteLaundry(n(REAL.basement3br))).toBe(true);
    expect(extractInSuiteLaundry(n(REAL.wilsonSubway))).toBe(true);
  });

  it('does not mistake shared building laundry for in-suite', () => {
    expect(extractInSuiteLaundry(n(REAL.beaches))).toBe(false);
    expect(extractInSuiteLaundry(n('Laundry room in the building'))).toBe(false);
  });

  it('returns null when the ad is silent', () => {
    expect(extractInSuiteLaundry(n(REAL.luxuryCondo))).toBeNull();
  });
});

describe('extractUtilities', () => {
  it('expands "ALL INCLUSIVE" into the standard set', () => {
    const found = extractUtilities(n(REAL.wilsonSubway));
    expect(found).toEqual(expect.arrayContaining(['heat', 'water', 'hydro']));
  });

  it('picks up a single named utility', () => {
    expect(extractUtilities(n(REAL.beaches))).toContain('heat');
  });

  it('reads a bare "Utilities" inside an inclusion clause', () => {
    const found = extractUtilities(n(REAL.islingtonBasement));
    expect(found).toEqual(expect.arrayContaining(['heat', 'water', 'hydro']));
    expect(found).toContain('internet');
  });

  it('lets an explicit exclusion override a blanket claim', () => {
    const found = extractUtilities(n('All utilities included. Hydro is extra.'));
    expect(found).not.toContain('hydro');
    expect(found).toContain('heat');
  });

  it('returns an empty list when nothing is claimed', () => {
    expect(extractUtilities(n('Bright unit close to transit'))).toEqual([]);
  });
});

describe('extractBuiltBefore2018', () => {
  it('reads "brand new" as outside rent control', () => {
    expect(extractBuiltBefore2018(n(REAL.luxuryCondo))).toBe(false);
    expect(extractBuiltBefore2018(n(REAL.danforthCondo))).toBe(false);
  });

  it('reads a stated build year against the November 2018 threshold', () => {
    expect(extractBuiltBefore2018(n('Built in 1974, well maintained'))).toBe(true);
    expect(extractBuiltBefore2018(n('Constructed 2021'))).toBe(false);
  });

  it('returns null when the ad says nothing', () => {
    expect(extractBuiltBefore2018(n(REAL.beaches))).toBeNull();
  });
});

describe('toSearchableText', () => {
  it('takes an HTML ad body straight to matchable text', () => {
    const html = '<p>Bright 2 Bed + Den</p><ul><li>Parking &amp; Locker Included</li></ul>';
    const text = toSearchableText(html);
    expect(extractDens(text)).toBe(1);
    expect(extractLocker(text)).toBe(true);
  });
});
