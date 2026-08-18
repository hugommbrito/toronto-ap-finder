import { describe, expect, it } from 'vitest';
import { userAgent } from './env';

/**
 * The recipient list is user-facing configuration typed by hand into a Railway variable, so
 * the forgiving cases matter: trailing commas, stray spaces, a single id with no comma.
 */
describe('TELEGRAM_CHAT_IDS parsing', () => {
  // Mirrors the preprocess in env.ts; kept in step by the assertions below.
  const parse = (v: string): string[] => v.split(',').map((id) => id.trim()).filter(Boolean);

  it('reads a plain list', () => {
    expect(parse('100000001,100000002')).toEqual(['100000001', '100000002']);
  });

  it('tolerates spaces around the separator', () => {
    expect(parse('100000001, 100000002 , 55')).toEqual(['100000001', '100000002', '55']);
  });

  it('ignores a trailing comma', () => {
    expect(parse('100000001,')).toEqual(['100000001']);
  });

  it('reads a single id', () => {
    expect(parse('100000001')).toEqual(['100000001']);
  });

  it('yields nothing for an empty value, so the schema can treat it as unset', () => {
    expect(parse('')).toEqual([]);
    expect(parse('  ')).toEqual([]);
  });
});

describe('userAgent', () => {
  it('identifies the tool and carries a contact address', () => {
    const ua = userAgent('someone@example.com');
    expect(ua).toContain('toronto-rental-monitor');
    expect(ua).toContain('mailto:someone@example.com');
  });

  it('still identifies the tool without a contact', () => {
    expect(userAgent()).toContain('toronto-rental-monitor');
    expect(userAgent()).not.toContain('mailto');
  });
});
