import { z } from 'zod';

/**
 * A key present but blank in .env is "unset", not "set to an invalid value" — dotenv
 * cannot express the difference, so normalise it here rather than making every optional
 * field fail validation on a placeholder line.
 */
const optionalString = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().optional(),
);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  /**
   * Optional here, but Nominatim's usage policy requires an identifiable contact, so the
   * geocoding fallback refuses to run without it. Overpass and CKAN only get a warning.
   */
  SCRAPER_CONTACT_EMAIL: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().email().optional(),
  ),
  TELEGRAM_BOT_TOKEN: optionalString,
  /**
   * Comma-separated Telegram chat ids, e.g. "100000001,100000002". Everyone listed gets
   * every notification this profile sends. Env vars are strings, so the list lives as one.
   */
  TELEGRAM_CHAT_IDS: z.preprocess(
    (v) =>
      typeof v === 'string'
        ? v.split(',').map((id) => id.trim()).filter(Boolean)
        : v,
    z.array(z.string().min(1)).optional(),
  ),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

export const APP_NAME = 'toronto-rental-monitor';
export const APP_VERSION = '0.1.0';

/**
 * Identifiable User-Agent. Section 13 of the brief makes this mandatory, and Nominatim
 * and Overpass both ask for it in their usage policies.
 */
export function userAgent(contactEmail?: string): string {
  const contact = contactEmail ? `; +mailto:${contactEmail}` : '';
  return `${APP_NAME}/${APP_VERSION} (personal rental search${contact})`;
}
