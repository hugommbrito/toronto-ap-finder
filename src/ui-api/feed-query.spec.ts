import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  MAX_MAP_POINTS,
  MAX_PAGE_SIZE,
  feedQuerySchema,
  mapQuerySchema,
  parseOrBadRequest,
  stateUpdateSchema,
} from './feed-query';

describe('feedQuerySchema', () => {
  it('fills the defaults from a bare profile', () => {
    const q = feedQuerySchema.parse({ profile: 'sister' });
    expect(q).toEqual({
      profile: 'sister',
      minScore: undefined,
      maxRent: undefined,
      tier: undefined,
      city: undefined,
      area: undefined,
      source: undefined,
      includeDelisted: false,
      includeDismissed: false,
      status: undefined,
      sort: 'score',
      page: 1,
      limit: 30,
    });
  });

  it('requires a profile, because a score is a fact about a (listing, profile) pair', () => {
    expect(feedQuerySchema.safeParse({}).success).toBe(false);
    expect(feedQuerySchema.safeParse({ profile: '' }).success).toBe(false);
  });

  it('clamps a silly limit rather than rejecting it', () => {
    expect(feedQuerySchema.parse({ profile: 'p', limit: '5000' }).limit).toBe(MAX_PAGE_SIZE);
    expect(feedQuerySchema.parse({ profile: 'p', limit: '10' }).limit).toBe(10);
    expect(feedQuerySchema.safeParse({ profile: 'p', limit: '0' }).success).toBe(false);
  });

  it('rejects a page below one', () => {
    expect(feedQuerySchema.safeParse({ profile: 'p', page: '0' }).success).toBe(false);
    expect(feedQuerySchema.parse({ profile: 'p', page: '3' }).page).toBe(3);
  });

  it('reads booleans the way a query string spells them', () => {
    for (const yes of ['1', 'true']) {
      expect(feedQuerySchema.parse({ profile: 'p', includeDelisted: yes }).includeDelisted).toBe(true);
    }
    for (const no of ['0', 'false', '']) {
      expect(feedQuerySchema.parse({ profile: 'p', includeDelisted: no }).includeDelisted).toBe(false);
    }
    expect(feedQuerySchema.safeParse({ profile: 'p', includeDelisted: 'yes' }).success).toBe(false);
  });

  it('accepts sources comma-separated or as a repeated key', () => {
    expect(feedQuerySchema.parse({ profile: 'p', source: 'kijiji, zumper' }).source).toEqual(['kijiji', 'zumper']);
    expect(feedQuerySchema.parse({ profile: 'p', source: ['kijiji', 'zumper'] }).source).toEqual(['kijiji', 'zumper']);
    expect(feedQuerySchema.parse({ profile: 'p', source: '' }).source).toBeUndefined();
  });

  it('treats a blank number as absent, never as zero', () => {
    // `?minScore=` with nothing after it must not silently open the whole corpus.
    expect(feedQuerySchema.parse({ profile: 'p', minScore: '' }).minScore).toBeUndefined();
    expect(feedQuerySchema.parse({ profile: 'p', minScore: '0' }).minScore).toBe(0);
    expect(feedQuerySchema.parse({ profile: 'p', minScore: '72.5' }).minScore).toBe(72.5);
    expect(feedQuerySchema.safeParse({ profile: 'p', minScore: '101' }).success).toBe(false);
    expect(feedQuerySchema.safeParse({ profile: 'p', minScore: 'abc' }).success).toBe(false);
  });

  it('rejects an unknown sort and a blank one falls back to score', () => {
    expect(feedQuerySchema.safeParse({ profile: 'p', sort: 'price' }).success).toBe(false);
    expect(feedQuerySchema.parse({ profile: 'p', sort: '' }).sort).toBe('score');
    expect(feedQuerySchema.parse({ profile: 'p', sort: 'rent' }).sort).toBe('rent');
  });
});

describe('mapQuerySchema', () => {
  it('takes the feed narrowing and drops what only a list needs', () => {
    // A hash copied from the list carries page and sort; the map must swallow them, not 400.
    const q = mapQuerySchema.parse({ profile: 'sister', page: '3', limit: '10', sort: 'rent', minScore: '40' });
    expect(q).toEqual({
      profile: 'sister',
      minScore: 40,
      maxRent: undefined,
      tier: undefined,
      city: undefined,
      area: undefined,
      source: undefined,
      includeDelisted: false,
      includeDismissed: false,
      status: undefined,
    });
    expect('page' in q).toBe(false);
    expect('sort' in q).toBe(false);
  });

  it('still requires a profile and still validates what it keeps', () => {
    expect(mapQuerySchema.safeParse({}).success).toBe(false);
    expect(mapQuerySchema.safeParse({ profile: 'p', minScore: '101' }).success).toBe(false);
  });

  it('caps the marker set at a number the browser can draw', () => {
    expect(MAX_MAP_POINTS).toBe(1500);
  });
});

describe('stateUpdateSchema', () => {
  it('requires at least one field, or the request means nothing', () => {
    expect(stateUpdateSchema.safeParse({}).success).toBe(false);
    expect(stateUpdateSchema.safeParse({ status: 'favourite' }).success).toBe(true);
    expect(stateUpdateSchema.safeParse({ note: 'x' }).success).toBe(true);
  });

  it('turns a blank note into null so "no note" has one spelling', () => {
    expect(stateUpdateSchema.parse({ note: '   ' }).note).toBeNull();
    expect(stateUpdateSchema.parse({ note: null }).note).toBeNull();
    expect(stateUpdateSchema.parse({ note: ' ligar amanhã ' }).note).toBe(' ligar amanhã ');
  });

  it('rejects unknown fields and unknown statuses', () => {
    expect(stateUpdateSchema.safeParse({ status: 'loved' }).success).toBe(false);
    expect(stateUpdateSchema.safeParse({ status: 'favourite', score: 99 }).success).toBe(false);
  });
});

describe('parseOrBadRequest', () => {
  it('reports every issue at once as a 400', () => {
    expect(() => parseOrBadRequest(feedQuerySchema, { page: '0', sort: 'nope' })).toThrow(BadRequestException);
    try {
      parseOrBadRequest(feedQuerySchema, { page: '0', sort: 'nope' });
    } catch (err) {
      const messages = (err as BadRequestException).getResponse() as { message: string[] };
      expect(messages.message.some((m) => m.startsWith('profile'))).toBe(true);
      expect(messages.message.some((m) => m.startsWith('page'))).toBe(true);
      expect(messages.message.some((m) => m.startsWith('sort'))).toBe(true);
    }
  });
});
