import { z } from 'zod';

/**
 * A bedroom requirement is not a number. "3BR" and "2BR + den" are equivalent for
 * some tenants and not for others, so the rule is a recursive expression that each
 * profile carries in its own jsonb. The evaluator (see scoring/bedroom-rule.ts)
 * walks this tree; adding a new shape of rule must never require a code branch
 * keyed on a profile id.
 */
export type BedroomRule =
  | { kind: 'min'; beds: number }
  | { kind: 'bedsPlusDen'; beds: number }
  | { kind: 'anyOf'; rules: BedroomRule[] };

export const bedroomRuleSchema: z.ZodType<BedroomRule> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('min'), beds: z.number().int().nonnegative() }),
    z.object({ kind: z.literal('bedsPlusDen'), beds: z.number().int().nonnegative() }),
    z.object({ kind: z.literal('anyOf'), rules: z.array(bedroomRuleSchema).min(1) }),
  ]),
);

export const hardFiltersSchema = z.object({
  /**
   * Funnel guard, not a preference. Rent preference lives in soft.targetRent; this
   * ceiling exists so the hydration stage stays bounded. Anything above it is
   * recorded in rejection_log rather than dropped, so the cost of the guard stays visible.
   */
  totalRentMax: z.number().positive(),
  totalRentMin: z.number().positive().optional(),
  bedroomRule: bedroomRuleSchema,
  /** null = no date cut-off ("as soon as possible"). */
  availableFrom: z.string().date().nullable(),
  requireParking: z.boolean(),
  minDaycaresWithin: z
    .object({
      radiusM: z.number().positive(),
      count: z.number().int().positive(),
      /**
       * Which licensed-capacity column must be non-zero for a centre to count.
       * Maps to the City of Toronto dataset: IGSPACE/TGSPACE/PGSPACE/KGSPACE/SGSPACE.
       */
      ageGroup: z.enum(['infant', 'toddler', 'preschool', 'kindergarten', 'schoolage']),
    })
    .nullable(),
  /**
   * Reject a unit that is one part of a house split among separate households — a main-floor
   * unit with the basement let to someone else, or that basement on its own.
   *
   * A judgement about living arrangements, not about the building: shared entrance, shared
   * laundry, and a neighbour through the floor. Verified from the advertisement text, so it
   * only takes effect where listing verification is configured.
   */
  allowSplitDwelling: z.boolean().default(true),
  maxTransitWalkM: z.number().positive().nullable(),
  cities: z.array(z.string()).min(1),
  /**
   * Areas to cut outright, by name — a veto over `cities`, not a preference.
   *
   * `cities` cannot express this. Scarborough and East York have been part of the City of
   * Toronto since 1998, so every source is entitled to label a Scarborough listing
   * "Toronto"; the matcher agrees with them on purpose (see geo/city.ts). Removing
   * Scarborough from the allowlist therefore removes nothing at all.
   *
   * So this is resolved by position against the 1998 boundaries, falling back to the label
   * where there are no coordinates, and a listing whose area cannot be determined goes to
   * needs_review rather than passing. Names must match data/seed/municipal-boundaries.json:
   * Scarborough, North York, East York, Etobicoke, York, Old Toronto — plus any separate
   * municipality, which needs no geometry because its own name identifies it.
   */
  excludeAreas: z.array(z.string()).default([]),
});

/**
 * A preference ladder over unit layouts, evaluated in order — **first match wins**.
 *
 * Bedrooms are not a threshold any more than rent is. Three bedrooms means a study that is
 * not also a bedroom; two-plus-den means the den becomes the office; two means the office
 * moves into the master bedroom. All three are liveable, in descending order, so the right
 * model is a scored ladder and not a cut.
 *
 * Order matters and is the caller's responsibility: a 3BR also satisfies `min: 2`, so the
 * stricter tier has to come first.
 */
export const bedroomTierSchema = z.object({
  label: z.string(),
  rule: bedroomRuleSchema,
  value: z.number().min(0).max(1),
});

export const softPreferencesSchema = z.object({
  /**
   * Weights need not sum to 100; the scorer normalises by the sum of the weights
   * actually present. An unknown key is a configuration error and fails loudly
   * rather than being silently ignored.
   */
  weights: z.record(z.string(), z.number().nonnegative()),
  bedroomTiers: z.array(bedroomTierSchema).min(1).optional(),
  targetRent: z.number().positive().optional(),
  /**
   * Walking distance at which the transit components reach zero.
   *
   * Separate from hard.maxTransitWalkM so that distance can be scored without also being a
   * cut-off. When absent it falls back to the hard limit, which keeps profiles that do want
   * a hard cut behaving as before.
   */
  transitWalkZeroM: z.number().positive().optional(),
  anchors: z
    .array(
      z.object({
        label: z.string(),
        lat: z.number(),
        lng: z.number(),
        maxWalkM: z.number().positive(),
        weight: z.number().nonnegative(),
      }),
    )
    .optional(),
});

export const notifySchema = z.object({
  /**
   * Everyone who should receive this profile's notifications.
   *
   * Still one notification per unit per profile — the unique index is on
   * (profile_id, fingerprint), not on the recipient — so adding a reader fans the same
   * decision out to more phones rather than multiplying the decisions.
   */
  telegramChatIds: z.array(z.string().min(1)).min(1),
  minScore: z.number().min(0).max(100),
  /** [startHour, endHour] in America/Toronto; notifications inside the window are deferred. */
  quietHours: z.tuple([z.number().int().min(0).max(23), z.number().int().min(0).max(23)]).optional(),
  /**
   * Follow each notification with a native Telegram location pin.
   *
   * A second message per listing, so it is a profile setting rather than a fixed behaviour:
   * nine notifications become eighteen messages, and whether that is useful or noisy is a
   * matter of taste rather than of code.
   */
  includeMap: z.boolean().default(true),
});

export const tenantProfileSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  active: z.boolean(),
  hard: hardFiltersSchema,
  soft: softPreferencesSchema,
  notify: notifySchema,
});

export type HardFilters = z.infer<typeof hardFiltersSchema>;
export type SoftPreferences = z.infer<typeof softPreferencesSchema>;
export type BedroomTier = z.infer<typeof bedroomTierSchema>;
export type NotifySettings = z.infer<typeof notifySchema>;
export type TenantProfile = z.infer<typeof tenantProfileSchema>;
export type DaycareAgeGroup = HardFilters['minDaycaresWithin'] extends infer T
  ? T extends { ageGroup: infer A }
    ? A
    : never
  : never;
