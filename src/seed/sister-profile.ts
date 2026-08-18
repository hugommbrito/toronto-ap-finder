import { tenantProfileSchema, type TenantProfile } from '@/profiles/profile.schema';

/**
 * The first real tenant profile. Every value here is data, not code — a second tenant is
 * another object of this shape and nothing else.
 *
 * Decisions behind the numbers:
 *
 * - targetRent 2700 is the actual goal; totalRentMax 3200 is only a funnel guard, so that
 *   the hydration stage stays bounded. Rent is scored, not gated: a listing above target
 *   still competes, it just ranks worse. See the rentBelowTarget component.
 * - bedrooms work the same way. Three bedrooms is the goal (couple, child, and a study that
 *   is not also a bedroom); 2+den puts the office in the den; a plain 2BR puts it in the
 *   master bedroom. All three are liveable in descending order, so the hard filter is only a
 *   floor at 2 and the preference lives in bedroomTiers. Accepting plain 2BRs raises the
 *   Toronto candidate pool from ~1,700 listings to ~4,600.
 * - daycare age group is toddler, which filters the City of Toronto dataset to centres
 *   with TGSPACE > 0. A centre with 60 preschool places and no toddler places is no use.
 * - availableFrom is null: the move is "as soon as possible", so no date cut-off.
 * - the five city names are one municipality (amalgamated 1998); listing them spells out
 *   the intent of "anywhere in the 416".
 * - anchors is empty on purpose. Home office means there is no commute to optimise, which
 *   is exactly why transit weighs less than childcare here.
 */
export function buildSisterProfile(telegramChatIds: string[]): TenantProfile {
  const profile: TenantProfile = {
    id: 'sister',
    label: 'Irmã — 3BR ou 2BR+den, Toronto',
    active: true,
    hard: {
      totalRentMax: 3200,
      /**
       * Not a preference — a plausibility floor.
       *
       * Room and shared rentals get posted in the apartments category, and their bedroom
       * count describes the whole unit rather than what is actually for rent. A real one
       * from the first live cycle: "Private room 736 Spadina Ave" at 990, tagged as a
       * 2-bedroom, scored highest of everything found. No genuine 2BR in Toronto rents for
       * that, so a floor removes the whole class — and takes obvious scam bait with it.
       * 1500 is set below the cheapest genuine unit seen (a 1,600 North York basement 2BR)
       * so it cuts the impostors without cutting the bargains.
       */
      totalRentMin: 1500,
      // Floor only. Below two bedrooms there is nowhere to put the child, so it is a genuine
      // elimination; everything above is ranked by soft.bedroomTiers rather than cut.
      bedroomRule: { kind: 'min', beds: 2 },
      availableFrom: null,
      requireParking: true,
      /**
       * A main-floor unit with the basement let separately means a neighbour through the
       * floor, a shared entrance and shared laundry. Costly: split houses were 4 of the 9
       * listings that cleared the bar in a live sample, so this narrows the shortlist
       * sharply. Set it back to true with one UPDATE if the funnel gets too thin.
       */
      allowSplitDwelling: false,
      minDaycaresWithin: { radiusM: 800, count: 1, ageGroup: 'toddler' },
      /**
       * No hard cut on transit — distance is scored instead (soft.transitWalkZeroM).
       *
       * A 900 m limit was the single most destructive filter in the first live cycle: 41%
       * of all rejections, and 23 listings that failed on nothing else. The distances that
       * died clustered just past the line — 971 m, 1,058 m, 1,069 m — about a minute of
       * walking. With a home office there is no commute to protect, which is the same
       * reason transit weighs less than childcare here.
       */
      maxTransitWalkM: null,
      cities: ['Toronto', 'North York', 'Etobicoke', 'Scarborough', 'East York'],
    },
    soft: {
      targetRent: 2700,
      // Full credit within 400 m, fading to nothing at 1,200 m. Beyond that a listing simply
      // scores zero on transit and competes on everything else.
      transitWalkZeroM: 1200,
      // Strictest first: first match wins, and a 3BR also satisfies the 2BR rule below it.
      bedroomTiers: [
        { label: '3BR+ — separate office', rule: { kind: 'min', beds: 3 }, value: 1.0 },
        { label: '2BR + den — den as office', rule: { kind: 'bedsPlusDen', beds: 2 }, value: 0.7 },
        { label: '2BR — office in the bedroom', rule: { kind: 'min', beds: 2 }, value: 0.15 },
      ],
      weights: {
        /**
         * Weighted to make a plain 2BR surface only when it is exceptional.
         *
         * With the weights summing to 140, bedroomFit is worth at most 25.0 final points and
         * rentBelowTarget at most 21.4. A plain 2BR therefore gives up 21.25 points of
         * layout, slightly more than the entire price advantage it could possibly earn — so
         * a 2BR at 2,700 merely ties a 3BR at 3,200, and loses in every less extreme case.
         * The median 2BR drops ~21 points, which puts it under minScore 55 and stops it
         * being notified at all.
         */
        bedroomFit: 35,
        // Rent is the second largest lever: the target sits well below market, so the
        // ranking has to be able to tell 2,750 from 3,150.
        rentBelowTarget: 30,
        daycareProximity: 15,
        daycareRedundancy: 15,
        // A CWELCC place is worth CAD 800-1200/month against private rates — more than the
        // gap between two listings in this band, which is why it earns its own weight.
        daycareAffordability: 15,
        transitOperational: 15,
        locker: 5,
        rentControlled: 5,
        transitFuture: 3,
        inSuiteLaundry: 2,
      },
      anchors: [],
    },
    notify: {
      telegramChatIds,
      /**
       * Raised from 55 after the first live cycles. Dropping the hard transit cut widened
       * the funnel roughly sixfold, and at 55 fourteen of twenty scored listings would have
       * been sent — a feed that noisy stops being read.
       *
       * 70 was tried first and rejected: it scored an outstanding 2BR at 69.9, which would
       * have silenced exactly the case this profile is meant to catch. 65 keeps that one
       * and still holds back a bit over half of what gets scored.
       *
       * This is the number to move first if the feed feels wrong in either direction, and
       * moving it is one UPDATE against this row.
       */
      minScore: 65,
      quietHours: [22, 7],
      // A location pin after each notification — one tap to the neighbourhood, directions
      // and street view, which a small static image inside Telegram could not match.
      includeMap: true,
    },
  };

  return tenantProfileSchema.parse(profile);
}
