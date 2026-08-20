import type { TenantProfile } from '@/profiles/profile.schema';
import { cityMatches } from '@/geo/city';
import { excludedAreaOf } from '@/geo/areas';
import { evaluateBedroomRule } from './bedroom-rule';
import type { GeoIndex } from './context';

export interface FilterableListing {
  beds: number | null;
  dens: number;
  totalMonthlyCost: number;
  parkingIncluded: boolean | null;
  parkingCost: number | null;
  city: string | null;
  lat: number | null;
  lng: number | null;
  availableFrom: string | null;
}

export interface Rejection {
  reason: string;
  detail: Record<string, unknown>;
}

export interface Review {
  field: string;
  reason: string;
}

export interface HardFilterResult {
  /**
   * 'pass'   — every hard filter satisfied.
   * 'reject' — at least one filter definitively failed; goes to rejection_log.
   * 'review' — nothing failed, but something could not be determined; goes to needs_review.
   *
   * Nothing is ever dropped silently. That is what makes it possible to tell, in week one,
   * which filter is strangling the funnel.
   */
  decision: 'pass' | 'reject' | 'review';
  rejections: Rejection[];
  reviews: Review[];
}

export function applyHardFilters(
  listing: FilterableListing,
  profile: TenantProfile,
  geo: GeoIndex,
): HardFilterResult {
  const hard = profile.hard;
  const rejections: Rejection[] = [];
  const reviews: Review[] = [];

  // --- bedrooms ---
  const bedroomOk = evaluateBedroomRule(hard.bedroomRule, { beds: listing.beds, dens: listing.dens });
  if (bedroomOk === false) {
    rejections.push({
      reason: 'bedroom_rule',
      detail: { beds: listing.beds, dens: listing.dens, rule: hard.bedroomRule },
    });
  } else if (bedroomOk === null) {
    reviews.push({ field: 'beds', reason: 'bedroom count could not be determined' });
  }

  // --- rent ---
  // A funnel guard, not a preference: the preference is scored by rentBelowTarget. Logging
  // the overshoot means a ceiling that is set too low shows up as a near-miss pile.
  if (listing.totalMonthlyCost > hard.totalRentMax) {
    rejections.push({
      reason: 'rent_ceiling',
      detail: {
        totalMonthlyCost: listing.totalMonthlyCost,
        ceiling: hard.totalRentMax,
        overshoot: Math.round(listing.totalMonthlyCost - hard.totalRentMax),
      },
    });
  }
  if (hard.totalRentMin !== undefined && listing.totalMonthlyCost < hard.totalRentMin) {
    rejections.push({
      reason: 'rent_floor',
      detail: { totalMonthlyCost: listing.totalMonthlyCost, floor: hard.totalRentMin },
    });
  }

  // --- parking ---
  if (hard.requireParking) {
    const included = listing.parkingIncluded === true;
    // "Parking available for $X" satisfies the requirement, but only because that cost has
    // already been folded into totalMonthlyCost upstream.
    const purchasable = listing.parkingCost !== null;
    if (!included && !purchasable) {
      if (listing.parkingIncluded === false) {
        rejections.push({ reason: 'no_parking', detail: { parkingIncluded: false } });
      } else {
        reviews.push({ field: 'parkingIncluded', reason: 'ad does not mention parking' });
      }
    }
  }

  // --- city ---
  if (listing.city === null) {
    reviews.push({ field: 'city', reason: 'city could not be determined' });
  } else if (!cityMatches(listing.city, hard.cities)) {
    rejections.push({ reason: 'city', detail: { city: listing.city, allowed: hard.cities } });
  }

  // --- excluded areas ---
  // Separate from the city check and unable to be folded into it: the areas that get cut here
  // are the same municipality as the ones that get kept, so only position can separate them.
  if (hard.excludeAreas.length > 0) {
    const verdict = excludedAreaOf(listing, hard.excludeAreas);
    if (verdict.kind === 'inside') {
      rejections.push({
        reason: 'excluded_area',
        detail: { area: verdict.area, determinedBy: verdict.by, city: listing.city },
      });
    } else if (verdict.kind === 'unknown') {
      reviews.push({ field: verdict.field, reason: verdict.reason });
    }
  }

  // --- availability ---
  if (hard.availableFrom !== null) {
    if (listing.availableFrom === null) {
      reviews.push({ field: 'availableFrom', reason: 'no availability date in the ad' });
    } else if (listing.availableFrom > hard.availableFrom) {
      rejections.push({
        reason: 'available_too_late',
        detail: { availableFrom: listing.availableFrom, requiredBy: hard.availableFrom },
      });
    }
  }

  // --- geography ---
  const hasCoords = listing.lat !== null && listing.lng !== null;
  if (!hasCoords) {
    if (hard.minDaycaresWithin || hard.maxTransitWalkM !== null) {
      reviews.push({ field: 'coordinates', reason: 'no coordinates, geographic filters unevaluated' });
    }
  } else {
    const point = { lat: listing.lat!, lng: listing.lng! };

    if (hard.minDaycaresWithin) {
      const { radiusM, count, ageGroup } = hard.minDaycaresWithin;
      const found = geo.daycaresWithin(point, radiusM, ageGroup).length;
      if (found < count) {
        rejections.push({
          reason: 'daycare_coverage',
          detail: { found, required: count, radiusM, ageGroup },
        });
      }
    }

    if (hard.maxTransitWalkM !== null) {
      const nearest = geo.nearestStation(point, 'operational');
      if (!nearest || nearest.distanceM > hard.maxTransitWalkM) {
        rejections.push({
          reason: 'transit_distance',
          detail: {
            nearestM: nearest ? Math.round(nearest.distanceM) : null,
            nearestStation: nearest?.station.name ?? null,
            maxWalkM: hard.maxTransitWalkM,
          },
        });
      }
    }
  }

  const decision = rejections.length > 0 ? 'reject' : reviews.length > 0 ? 'review' : 'pass';
  return { decision, rejections, reviews };
}
