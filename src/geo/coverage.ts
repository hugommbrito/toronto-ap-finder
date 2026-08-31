import { canonicalMunicipality } from './city';

/**
 * Which geographic facts we actually have for a listing's municipality.
 *
 * This exists because the seeded geography is not co-extensive with the search area any more.
 * The City of Toronto publishes licensed child care with **capacity per age group**
 * (IGSPACE/TGSPACE/...), and every hard filter and score component was written against that
 * shape. No other region publishes it. Peel and Waterloo publish where the centres are, with
 * coordinates, and nothing about who they are licensed for; the County of Simcoe publishes
 * nothing at all.
 *
 * So `daycaresWithin(...).length === 0` stopped being one fact and became three:
 *
 *   - Toronto: we looked, with the age group applied, and there is nothing. A real verdict.
 *   - Peel/Waterloo: we cannot apply the age group at all. Zero centres still proves absence,
 *     but any positive count proves only that *a* centre is there.
 *   - anywhere else: we have no data, so we know nothing.
 *
 * Collapsing those three into a rejection is what would make a data gap wear the costume of a
 * verdict — the same failure `excludedAreaOf` is written to avoid (see areas.ts). Hence a
 * verdict type rather than a boolean.
 *
 * Decided by municipality name rather than by geometry, deliberately: a separate municipality
 * canonicalises to itself, so its own name identifies it and no boundary file is needed. Only
 * the pre-1998 Toronto areas are ambiguous by name, and they are all inside `full` anyway.
 */
export type DaycareCoverage = 'full' | 'presenceOnly' | 'none';

export interface CoverageRegion {
  /** Matches `daycares.region`, and the id prefix used when seeding. */
  key: string;
  label: string;
  daycare: DaycareCoverage;
}

const TORONTO: CoverageRegion = { key: 'toronto', label: 'City of Toronto', daycare: 'full' };
const PEEL: CoverageRegion = { key: 'peel', label: 'Region of Peel', daycare: 'presenceOnly' };
const WATERLOO: CoverageRegion = { key: 'waterloo', label: 'Region of Waterloo', daycare: 'presenceOnly' };

/**
 * Municipality (canonical) to the region whose dataset covers it.
 *
 * Every municipality of a seeded region is listed, not just the ones in the profile: the
 * region's dataset covers all of them, so claiming otherwise would be a lie the moment a
 * profile added Brampton. Absent from this map means `none` — which is a claim about *our
 * data*, never about the place.
 */
const REGION_BY_MUNICIPALITY: Record<string, CoverageRegion> = {
  toronto: TORONTO,
  mississauga: PEEL,
  brampton: PEEL,
  caledon: PEEL,
  cambridge: WATERLOO,
  kitchener: WATERLOO,
  waterloo: WATERLOO,
  wilmot: WATERLOO,
  wellesley: WATERLOO,
  woolwich: WATERLOO,
  'north dumfries': WATERLOO,
};

export const SEEDED_REGIONS: readonly CoverageRegion[] = [TORONTO, PEEL, WATERLOO];

/** The region covering a city label, or null when nothing we seeded does. */
export function regionOf(city: string | null | undefined): CoverageRegion | null {
  if (!city) return null;
  return REGION_BY_MUNICIPALITY[canonicalMunicipality(city)] ?? null;
}

export function daycareCoverageOf(city: string | null | undefined): DaycareCoverage {
  return regionOf(city)?.daycare ?? 'none';
}
