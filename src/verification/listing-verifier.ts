import { Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { TriageListing } from '@/listings/listing.types';

/** The only model this runs on. Changing it is a one-line decision, made deliberately. */
export const VERIFIER_MODEL = 'claude-opus-5';

/**
 * Validated client-side with the project's Zod 3. The API is given the equivalent JSON
 * Schema below rather than a generated one, because the SDK's Zod helper targets Zod 4 and
 * migrating the profile schemas to satisfy it would be a large change for no gain here.
 */
export const verdictSchema = z.object({
  bedrooms: z.number().int().min(0).max(12),
  dens: z.number().int().min(0).max(5),
  isEntireUnit: z.boolean(),
  confidence: z.enum(['high', 'medium', 'low']),
  evidence: z.string(),
  notes: z.string(),
});

/** Kept in step with verdictSchema by the test that round-trips a sample through both. */
const VERDICT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    bedrooms: {
      type: 'integer',
      description: 'Bedrooms in the unit actually being rented. A den, office, or solarium is not a bedroom.',
    },
    dens: { type: 'integer', description: 'Dens, offices, or solariums included with the unit. 0 if none.' },
    isEntireUnit: {
      type: 'boolean',
      description:
        'True when a self-contained unit is for rent. False when what is for rent is a room, a shared space, or a bed in a home someone else occupies.',
    },
    confidence: {
      type: 'string',
      enum: ['high', 'medium', 'low'],
      description: 'high when the text states the layout plainly; low when you are inferring it.',
    },
    evidence: {
      type: 'string',
      description:
        'The phrase from the advertisement the bedroom and den counts rest on, quoted. Empty string if the text never states a layout.',
    },
    notes: {
      type: 'string',
      description: 'Anything else that contradicts the structured fields, in one sentence. Empty string if nothing.',
    },
  },
  required: ['bedrooms', 'dens', 'isEntireUnit', 'confidence', 'evidence', 'notes'],
  additionalProperties: false,
} as const;

export type Verdict = z.infer<typeof verdictSchema>;

export type VerificationResult =
  | { ok: true; verdict: Verdict }
  | { ok: false; error: string };

/**
 * The instruction is deliberately short.
 *
 * It names the one thing the model cannot infer — that the site's structured fields describe
 * the building rather than the unit, and that landlords inflate the bedroom dropdown to reach
 * more searches — and then gets out of the way. Step-by-step scaffolding and self-check
 * instructions measurably degrade this model's output, so there are none.
 */
const SYSTEM_PROMPT = `You read Toronto rental advertisements and report what is actually for rent.

The listing site's structured fields are unreliable in two specific ways. They describe the whole property, so a room advertised inside a three-bedroom house still reports three bedrooms. And landlords inflate the bedroom dropdown to appear in more searches, so a one-bedroom-plus-den is often filed as a two-bedroom.

Report the unit as the advertisement's own prose describes it. Where the prose says nothing about the layout, say so through low confidence and an empty evidence quote rather than repeating the structured figures back.`;

/**
 * Reads the advertisement and reports the layout the prose supports.
 *
 * Runs only on listings that would otherwise be notified — a handful a day — because the
 * question it answers ("is this actually the unit the fields claim?") only matters for
 * listings about to take up someone's attention.
 *
 * Never throws. A failed verification returns an error result and the pipeline proceeds
 * unverified: silently dropping a listing because an API call failed would be a worse
 * outcome than showing it with the uncertainty flagged.
 */
@Injectable()
export class ListingVerifier {
  private readonly logger = new Logger(ListingVerifier.name);
  private readonly client: Anthropic | null;

  constructor() {
    // The SDK also resolves ANTHROPIC_AUTH_TOKEN and `ant auth login` profiles, so absence
    // of the env var is not proof of absent credentials — but for a deployed service the
    // env var is the only path, and its absence is the useful signal.
    this.client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
  }

  get configured(): boolean {
    return this.client !== null;
  }

  async verify(listing: TriageListing): Promise<VerificationResult> {
    if (!this.client) return { ok: false, error: 'ANTHROPIC_API_KEY unset' };
    if (!listing.rawText) return { ok: false, error: 'listing has no advertisement text' };

    const claims = [
      `Structured fields from the listing site (treat as unreliable):`,
      `  bedrooms: ${listing.beds ?? 'not stated'}`,
      `  dens: ${listing.dens}`,
      `  monthly rent: ${listing.rentBase}`,
      `  unit type: ${listing.city ?? 'unknown'}`,
    ].join('\n');

    const body = [claims, '', `Advertisement title: ${listing.title}`, '', 'Advertisement text:', listing.rawText]
      .join('\n')
      .slice(0, 12000);

    try {
      const response = await this.client.messages.create({
        model: VERIFIER_MODEL,
        max_tokens: 4096,
        // Thinking is on by default on this model and shares max_tokens with the response;
        // 4096 leaves room for both on what is a short reading task.
        output_config: { effort: 'low', format: { type: 'json_schema', schema: VERDICT_JSON_SCHEMA } },
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: body }],
      });

      // Safety classifiers can decline; content is empty or partial when they do, so this
      // has to be checked before reading content at all.
      if (response.stop_reason === 'refusal') {
        return { ok: false, error: `refused: ${response.stop_details?.category ?? 'unknown'}` };
      }

      const text = response.content.find((b) => b.type === 'text');
      if (!text || text.type !== 'text') {
        return { ok: false, error: `no text block (stop_reason ${response.stop_reason})` };
      }

      const parsed = verdictSchema.safeParse(JSON.parse(text.text));
      if (!parsed.success) {
        return { ok: false, error: `verdict failed validation: ${parsed.error.message}` };
      }
      return { ok: true, verdict: parsed.data };
    } catch (err) {
      this.logger.warn(`verification failed for ${listing.sourceId}: ${(err as Error).message}`);
      return { ok: false, error: (err as Error).message };
    }
  }
}
