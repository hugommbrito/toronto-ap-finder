import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

/**
 * What the UI may ask for, validated the way the rest of the project validates: zod, not
 * class-validator. Query strings arrive as strings (or arrays, when a key repeats), so every field
 * here says how to read one.
 */

export const SORT_KEYS = ['score', 'rent', 'newest', 'posted', 'area'] as const;
export const LISTING_STATUSES = ['none', 'favourite', 'dismissed', 'contacted'] as const;
export const DEFAULT_PAGE_SIZE = 30;
export const MAX_PAGE_SIZE = 100;

/** `?minScore=` with nothing after it means "not given", not zero. */
const blank = (v: unknown): unknown => (v === '' ? undefined : v);

function optionalNumber<T extends z.ZodNumber>(schema: T) {
  return z.preprocess((v) => (v === '' || v === undefined ? undefined : v), schema.optional());
}

/** `?includeDelisted=1` and `=true` both mean yes; anything else, including absence, means no. */
const queryBoolean = z.preprocess((v) => {
  if (v === true || v === 'true' || v === '1') return true;
  if (v === false || v === 'false' || v === '0' || v === '' || v === undefined) return false;
  return v;
}, z.boolean());

/** `?source=kijiji,zumper` or `?source=kijiji&source=zumper` — express hands over either shape. */
const csvList = z.preprocess((v) => {
  if (v === undefined || v === '') return undefined;
  const parts = Array.isArray(v) ? v : String(v).split(',');
  const cleaned = parts.map((s) => String(s).trim()).filter(Boolean);
  return cleaned.length > 0 ? cleaned : undefined;
}, z.array(z.string().min(1)).optional());

export const feedQuerySchema = z.object({
  profile: z.string().min(1),
  minScore: optionalNumber(z.coerce.number().min(0).max(100)),
  maxRent: optionalNumber(z.coerce.number().positive()),
  /** Index into the profile's bedroomTiers. */
  tier: optionalNumber(z.coerce.number().int().min(0)),
  city: z.preprocess(blank, z.string().trim().min(1).optional()),
  area: z.preprocess(blank, z.string().trim().min(1).optional()),
  source: csvList,
  includeDelisted: queryBoolean,
  includeDismissed: queryBoolean,
  status: z.preprocess(blank, z.enum(['favourite', 'dismissed', 'contacted']).optional()),
  sort: z.preprocess(blank, z.enum(SORT_KEYS).default('score')),
  page: optionalNumber(z.coerce.number().int().min(1)).transform((n) => n ?? 1),
  // Clamped rather than rejected, like `?hours=` on /operations: a silly value still answers.
  limit: optionalNumber(z.coerce.number().int().min(1)).transform((n) =>
    Math.min(n ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
  ),
});
export type FeedQuery = z.infer<typeof feedQuerySchema>;

/**
 * The most listings the map will draw. Bounds the surroundings computation (one geography scan
 * per distinct location) and the payload; the response says when it applied.
 */
export const MAX_MAP_POINTS = 1500;

/**
 * The map takes the feed's narrowing and nothing about its order or its pages. `.omit` on a
 * `z.object` strips the unknown keys rather than rejecting them, so a `?page=3` copied over from
 * the list does not break the map.
 */
export const mapQuerySchema = feedQuerySchema.omit({ page: true, limit: true, sort: true });
export type MapQuery = z.infer<typeof mapQuerySchema>;

export const profileQuerySchema = z.object({ profile: z.string().min(1) });

/** A listing id that is not a uuid cannot name a row, so it is a 404 rather than a database error. */
export const listingIdSchema = z.string().uuid();

export const stateUpdateSchema = z
  .object({
    status: z.enum(LISTING_STATUSES).optional(),
    // A blank note is a cleared note. Stored as null so "no note" has one spelling.
    note: z
      .string()
      .max(4000)
      .nullable()
      .optional()
      .transform((n) => (typeof n === 'string' && n.trim() === '' ? null : n)),
  })
  .strict()
  .refine((b) => b.status !== undefined || b.note !== undefined, {
    message: 'at least one of status, note is required',
  });
export type StateUpdateBody = z.infer<typeof stateUpdateSchema>;

/** Every issue at once, not the first: a form with two bad fields should hear about both. */
export function parseOrBadRequest<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new BadRequestException(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`),
    );
  }
  return parsed.data as z.infer<T>;
}
