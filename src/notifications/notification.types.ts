import type { TriageListing } from '@/listings/listing.types';
import type { ScoreResult } from '@/scoring/scorer';
import type { Review } from '@/scoring/hard-filters';
import type { ReachableLine } from '@/scoring/context';

export interface NotificationPayload {
  listing: TriageListing;
  listingId: string;
  fingerprint: string;
  profileId: string;
  /** Every recipient for this profile. One decision, several phones. */
  chatIds: string[];
  score: ScoreResult;
  /**
   * Subway and LRT lines reachable on foot, closest first, each with the station that
   * serves it. Lines rather than stations: a second stop on a line you already have adds
   * nothing, a different line changes where you can go.
   */
  reachableLines: ReachableLine[];
  /** How far out reachableLines was measured — the profile's transit decay distance. */
  transitRadiusM: number;
  daycaresNearby: { total: number; cwelcc: number; radiusM: number };
  /** The one she would actually walk to. Named, because "3 nearby" is not an address. */
  nearestDaycare: { name: string; distanceM: number; cwelcc: boolean } | null;
  /** Send a location pin after the message. */
  includeMap: boolean;
  /**
   * Facts the ad never stated. Shown in the message rather than silently held back: a
   * strong listing whose ad forgot to mention parking is still worth seeing, as long as
   * the gap is visible.
   */
  unverified: Review[];
}

export interface Notifier {
  readonly name: string;
  send(payload: NotificationPayload): Promise<{ messageId: string | null }>;
}
