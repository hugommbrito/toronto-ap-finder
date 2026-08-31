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
 *   Outside Toronto no region publishes capacity per age group at all, which is why
 *   geo/coverage.ts exists and why such a listing is held for review rather than passed or
 *   rejected on a fact nobody has.
 * - availableFrom is null: the move is "as soon as possible", so no date cut-off.
 * - cities spans the 416 plus Mississauga and Cambridge. See the comment on the field: it is
 *   an accept filter, and the per-source search targets are what actually widen the search.
 * - anchors is empty on purpose. Home office means there is no commute to optimise — and
 *   since she bought a car, transit is a tie-breaker rather than a criterion, which is why
 *   transitOperational is 4 against childcare's 45.
 */
export function buildSisterProfile(telegramChatIds: string[]): TenantProfile {
  const profile: TenantProfile = {
    id: 'sister',
    label: 'Irmã — 3BR ou 2BR+den, 416 + Mississauga/Cambridge',
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
       * walking. With a home office there is no commute to protect, and now a car on top of
       * that, which is the same reason transit weighs 4 against childcare's 45.
       *
       * Leaving this null is what keeps the 905 evaluable at all: a hard walking limit would
       * eliminate essentially every Mississauga and Cambridge address on a criterion she no
       * longer needs.
       */
      maxTransitWalkM: null,
      /**
       * The 416 plus two 905 cities, which became viable once she had a car.
       *
       * The first three names are one municipality (amalgamated 1998); listing them spells
       * out "anywhere in the 416", minus the parts named in excludeAreas. Mississauga and
       * Cambridge are separate municipalities that canonicalise to themselves, so their own
       * names identify them and no geometry is needed.
       *
       * This list is an accept filter, not a query — what actually gets fetched is the
       * per-source search targets. Adding a name here without a matching target finds
       * nothing.
       */
      cities: ['Toronto', 'North York', 'Etobicoke', 'Mississauga', 'Cambridge'],
      /**
       * Refused outright. Not a preference to be outranked by a good price — she will not
       * live in these, so a listing there is worth nothing at any score.
       *
       * Note that trimming `cities` above is not what does this, and cannot be. Scarborough
       * and East York are the same municipality as Toronto (amalgamated 1998), so a source
       * is free to label a Scarborough listing "Toronto" and the city matcher deliberately
       * agrees — that is what makes "anywhere in the 416" work. The cut is therefore decided
       * by position against the 1998 boundaries; see geo/areas.ts.
       *
       * Brampton is different, and it is now load-bearing rather than belt-and-braces.
       * Kijiji has no Mississauga-only region: the search target is
       * `mississauga-peel-region`, which covers all of Peel and therefore returns Brampton
       * listings by the hundred. Before the 905 was added this entry excluded something the
       * allowlist already excluded; now it is the only thing standing between her and a feed
       * of Brampton.
       */
      excludeAreas: ['Scarborough', 'East York', 'Brampton'],
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
         * The weights sum to 142, but the number that decides anything is the **effective**
         * denominator, because null components drop out of it (see scorer.ts). Two cases:
         *
         * | 142 | everything scored, i.e. the ad matched a RentSafeTO building |
         * | 127 | the common case — no match, so buildingScore (15) is null    |
         *
         * At 127, bedroomFit is worth at most 27.6 final points and rentBelowTarget 23.6. A
         * plain 2BR sits on the 0.15 tier, so it gives up 23.4 points of layout against a
         * maximum price advantage of 23.6 — near-exact parity. A 2BR at 2,700 therefore only
         * ties a 3BR at 3,200, and loses in every less extreme case.
         *
         * (An earlier version of this comment said "weights summing to 140" and quoted 25.0
         * and 21.4. 140 was the effective denominator of the day, not the sum — the sum was
         * 155 once buildingScore was added. Keep the two labelled separately.)
         */
        bedroomFit: 35,
        // Rent is the second largest lever: the target sits well below market, so the
        // ranking has to be able to tell 2,750 from 3,150.
        rentBelowTarget: 30,
        /**
         * The largest single criterion after layout and price, because it is the one thing a
         * car did not solve: the child is dropped off and collected **on foot**. Raised from
         * 15 when transit was cut, and paid for out of daycareRedundancy rather than by
         * growing the daycare block, which stays at 45.
         */
        daycareProximity: 20,
        // Wait-lists are real, so a second reachable centre is genuine insurance — but with
        // walking distance now carrying 20, this is the half of the trade that gave way.
        daycareRedundancy: 10,
        // A CWELCC place is worth CAD 800-1200/month against private rates — more than the
        // gap between two listings in this band, which is why it earns its own weight.
        daycareAffordability: 15,
        /**
         * A tie-breaker, not a criterion — she has a car.
         *
         * Cut from 15 to 4. Distance to rapid transit is still worth *something* (a second
         * driver is not always available, and it holds value on resale), but it can no longer
         * decide between two listings on its own. This also removes an accidental penalty on
         * everywhere outside Toronto: at 15 an address with no subway within walking distance
         * forfeited 11.6 of the 100 final points, which is most of what made the 905 look bad
         * next to the 416 rather than merely different.
         */
        transitOperational: 4,
        locker: 5,
        rentControlled: 5,
        /**
         * High enough to break a tie, low enough not to outweigh childcare. Present for ~90%
         * of purpose-built units and ~15% of condo listings, so the curve is centred on the
         * municipal mean rather than linear — otherwise the mere fact of being inspected
         * would promote a whole segment.
         */
        buildingScore: 15,
        // Kept deliberately near-symbolic: a line opening in 2031 was already worth little
        // against one that exists today, and with a car it is worth less still.
        transitFuture: 1,
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
       * ⚠️ 65 was calibrated against weights summing to 155, and they now sum to 142 with
       * transit cut from 18 to 5. Every score shifted: a listing that had full marks on
       * transit lost ~7 points, and one far from any station gained relative ground. The
       * calibration this number rests on no longer describes the scale it is measuring, so
       * it is provisional until a cycle has been run and the distribution looked at.
       *
       * This is still the number to move first if the feed feels wrong in either direction,
       * and moving it is one UPDATE against this row.
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
