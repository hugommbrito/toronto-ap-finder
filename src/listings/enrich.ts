import { htmlToText, normalizeText } from '@/extraction/normalize';
import {
  extractBeds,
  extractBuiltBefore2018,
  extractDens,
  extractInSuiteLaundry,
  extractLocker,
  extractParking,
  extractSqft,
  extractUtilities,
} from '@/extraction/rules';
import type { TriageListing } from './listing.types';

/**
 * Merges what the advertisement text says into what the source structured.
 *
 * Precedence rule: a structured `true` is never overridden. Kijiji only ever asserts a
 * positive (see the parser's tristate handling), so the text is filling gaps, not arguing
 * with the source. The one exception is the den, explained below.
 */
export function enrichFromText(listing: TriageListing, descriptionHtml: string): TriageListing {
  const rawText = htmlToText(descriptionHtml);
  // The title carries real signal and is often where the den lives — "Renovated 2 Bdm. + Den"
  // had nothing about a den in its body. Matching on the body alone loses those.
  const text = normalizeText(`${listing.title}\n${rawText}`);

  const parkingFinding = extractParking(text);
  const parkingIncluded = listing.parkingIncluded ?? parkingFinding.included;
  // Only meaningful when parking is not already included in the rent. Structured cost wins
  // over the text here too — a source's own $150 is not something a regex should argue with.
  const parkingCost = parkingIncluded === true ? null : (listing.parkingCost ?? parkingFinding.cost);
  // The weaker claim: only worth recording while neither inclusion nor a price is known.
  const parkingAvailable =
    parkingIncluded !== null || parkingCost !== null
      ? null
      : (listing.parkingAvailable ?? (parkingFinding.available ? true : null));

  /**
   * Posters routinely put "2+1" in the title while leaving the dropdown at 2, so an explicit
   * den in the text upgrades a zero. It can only ever add a den, never remove one.
   *
   * But only when the prose agrees with the dropdown about the bedroom count. Landlords
   * inflate that dropdown to reach more searches: "1 bedroom plus den" filed as 2 bedrooms.
   * Upgrading the den there produced beds: 2, dens: 1 — a 1BR+den promoted to the
   * second-best rung of the layout ladder, which is exactly how 1BR+den units started
   * arriving highly ranked. When the two disagree, believe neither and flag it.
   */
  const textDens = extractDens(text);
  const conflict = detectLayoutConflict(listing.beds, text);
  const dens = !conflict && listing.dens === 0 && textDens === 1 ? 1 : listing.dens;

  const utilitiesIncluded = [...new Set([...listing.utilitiesIncluded, ...extractUtilities(text)])];

  return {
    ...listing,
    rawText,
    dens,
    parkingIncluded,
    parkingCost,
    parkingAvailable,
    utilitiesIncluded,
    areaSqft: listing.areaSqft ?? extractSqft(text),
    hasLocker: listing.hasLocker ?? extractLocker(text),
    inSuiteLaundry: listing.inSuiteLaundry ?? extractInSuiteLaundry(text),
    buildingBuiltBefore2018: listing.buildingBuiltBefore2018 ?? extractBuiltBefore2018(text),
    totalMonthlyCost: computeTotalMonthlyCost(listing.rentBase, parkingIncluded, parkingCost),
  };
}

export interface LayoutConflict {
  /** Bedroom count the advertisement text asserts. */
  textBeds: number;
  /** Bedroom count the source's structured field claims. */
  structuredBeds: number;
}

/**
 * Disagreement between what the source's bedroom field says and what the ad text says.
 *
 * Measured at 5 of 15 determinable listings in a live sample, always in the same direction:
 * the prose reports fewer bedrooms than the dropdown. That direction is the tell — prose is
 * written to describe the unit, the dropdown is chosen to reach searches.
 *
 * This reports the disagreement; it deliberately does not resolve it. The text extractor
 * takes the first bedroom mention it finds, which is right for "2 Bedroom + Den - Main Flr"
 * and wrong for "3 bedroom house, renting 1 room" — too naive to overrule the source on its
 * own. Resolution belongs to something that can actually read the ad.
 */
export function layoutConflictOf(listing: TriageListing): LayoutConflict | null {
  if (listing.rawText === null) return null;
  return detectLayoutConflict(listing.beds, normalizeText(`${listing.title}\n${listing.rawText}`));
}

export function detectLayoutConflict(
  structuredBeds: number | null,
  normalizedText: string,
): LayoutConflict | null {
  if (structuredBeds === null) return null;
  const textBeds = extractBeds(normalizedText);
  if (textBeds === null || textBeds === structuredBeds) return null;
  return { textBeds, structuredBeds };
}

/**
 * The number the whole ranking turns on.
 *
 * Parking offered at a price is added, because "parking available for $150" satisfies a
 * parking requirement only once that $150 is part of the monthly figure — conflating the
 * two is how a 3,150 listing quietly becomes a 3,300 one.
 *
 * Utilities are deliberately *not* monetised. Which ones are included is recorded, but
 * turning "hydro not included" into a dollar figure would mean inventing a number for a
 * unit whose size and heating we do not know, and injecting that guess into the single
 * most important input to the score. Better to leave it visible and unpriced.
 */
export function computeTotalMonthlyCost(
  rentBase: number,
  parkingIncluded: boolean | null,
  parkingCost: number | null,
): number {
  const parking = parkingIncluded === true ? 0 : (parkingCost ?? 0);
  return Math.round((rentBase + parking) * 100) / 100;
}
