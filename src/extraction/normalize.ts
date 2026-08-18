const HTML_BLOCK_BOUNDARY = /<\/(?:p|div|li|ul|ol|br|h[1-6]|tr)>|<br\s*\/?>/gi;
const HTML_TAG = /<[^>]*>/g;
const DIACRITIC_PATTERN = /\p{M}/gu;

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
  '&ndash;': '-',
  '&mdash;': '-',
};

/**
 * Kijiji serves the ad body as HTML (`<p><b>SUITE FEATURES:</b></p><ul><li>...`).
 * Block-level tags become separators rather than vanishing, so that "…laundry</li><li>No
 * parking…" does not silently become "laundry no parking" and confuse a proximity rule.
 */
export function htmlToText(html: string): string {
  return html
    .replace(HTML_BLOCK_BOUNDARY, '\n')
    .replace(HTML_TAG, ' ')
    .replace(/&[a-z#0-9]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

/**
 * Canonical form for rule matching: lowercase, accent-free, collapsed whitespace.
 *
 * Note the deviation from "strip all punctuation": `$`, `+`, `.` and `/` are load-bearing.
 * Removing them would destroy the exact tokens the rules depend on — "2+1", "$150/month",
 * "1.5 bath". Every other punctuation mark becomes a space.
 */
export function normalizeText(input: string): string {
  return input
    .normalize('NFD')
    .replace(DIACRITIC_PATTERN, '')
    .toLowerCase()
    .replace(/[^a-z0-9$+./\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Convenience for source adapters: HTML body straight to matchable text. */
export function toSearchableText(html: string): string {
  return normalizeText(htmlToText(html));
}
