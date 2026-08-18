# Kijiji — source notes

Investigated 2026-08-17. Everything below was checked against live responses, not assumed.
Re-verify before Phase 1 work: this is an internal, undocumented structure that can change
without notice.

## Loading mechanism

Kijiji's search results page is a Next.js app that server-renders its data into the HTML.

- `<script id="__NEXT_DATA__">` → `props.pageProps.__APOLLO_STATE__`
- Listings appear as `RealEstateListing:<id>` keys in that Apollo cache
- Pagination metadata at `ROOT_QUERY["searchResultsPageByUrl:<path>"].pagination`

**No Cloudflare challenge, no JS execution needed.** A plain GET with an ordinary
User-Agent returned HTTP 200 and the full payload. Playwright is not justified here, and
neither is `cheerio` for the search page — parse the JSON.

Category 37 (Apartments & Condos for Rent) in City of Toronto (location 1700273) reported
`totalCount: 7941`.

## robots.txt

Fetched from `https://www.kijiji.ca/robots.txt`. No `Crawl-delay`, no `Sitemap`.

**Re-checked automatically.** These rules were read by hand once; `pnpm probe` now re-reads
`robots.txt` weekly and evaluates it against the exact URL the adapter builds, recording the verdict
in `source_policy`. A move away from `green` alerts on Telegram. The conclusions below remain the
enforcement — the URL builders can only emit permitted forms, and tests assert it — but they are no
longer the only thing standing between a rule change and us not noticing.

**Allowed** (what the adapter uses):

- Category/location browse paths: `/b-apartments-condos/city-of-toronto/c37l1700273`
- Path-based pagination: `/b-apartments-condos/city-of-toronto/page-2/c37l1700273`
  (verified: returns `offset: 40`)
- Listing detail pages: `/v-apartments-condos/<city>/<slug>/<numeric-id>`
  The `Disallow: /v-*/*/*/c*` rule requires the fourth segment to start with `c`; detail
  URLs end in a numeric id, so they do not match.

**Disallowed** — every query-string search filter, including:

`?price=`, `?bedrooms=`, `?address=`, `?sort=`, `?radius=`, `?for-rent-by=`, and a long
list of amenity parameters. `?page=` and `?keywords=` are *not* disallowed, but path-based
pagination is used anyway.

### Consequence: filtering happens in memory

The bedroom filter has **no path-based equivalent** — every `seoUrl` in the
`numberbedrooms` filter catalogue comes back `null`, and the query-string form is
disallowed. So the adapter fetches unfiltered browse pages and applies the bedroom and
price filters client-side, over the JSON.

Default ordering on the plain path is already `sort=DATE&order=DESC`
(see `searchQuery.searchString`), so newest-first requires no forbidden parameter.

## Structured fields available without a detail fetch

From `RealEstateListing` on the search page:

| Field | Notes |
|---|---|
| `id`, `url`, `title` | |
| `price.amount` | **cents** — 182500 means $1,825.00 |
| `location.address` | full street address with postal code |
| `location.coordinates` | lat/lng — present in 46/46 sampled ads, so geocoding is a fallback, not the main path |
| `location.name` | the municipality label, e.g. `City of Toronto` |
| `activationDate`, `sortingDate` | `sortingDate` reflects bumps, not first posting |
| `adSource` | `TOP_AD` ads repeat across pages (10 overlapping between pages 1 and 2) |

From `attributes.all` (canonical name → value):

| Attribute | Encoding |
|---|---|
| `numberbedrooms` | **`.5` means "+ den"**: `2.5` = 2 Bed + Den, `1.5` = 1 + Den, `0` = Bachelor/Studio |
| `numberbathrooms` | **x10**: `10` = 1.0, `15` = 1.5, `20` = 2.0 |
| `numberparkingspots` | integer |
| `storagelocker`, `laundryinunit`, `laundryinbuilding` | `1`/`0` |
| `heat`, `hydro`, `water`, `cabletv`, `internet` | `1` = included in rent |
| `unittype` | `apartment` \| `basement-apartment` \| `condo` \| `house` \| `duplex-triplex` |
| `agreementtype` | `one-year` \| `month-to-month` |
| `areainfeet`, `petsallowed`, `furnished` | |

Bedroom distribution confirmed from the site's own filter counts (City of Toronto):
`2 + Den` 133, `3` 1115, `3 + Den` 34, `4` 278, `4 + Den` 13, `5+` 130 — about **1,700
ads** match the sister profile's bedroom rule before any other filter.

### `0` is ambiguous

`storagelocker: 0` appeared in 35 of 46 sampled ads. It means "no" *or* "the poster left it
blank" and the API does not distinguish them. Treat `1` as `true`, and `0` with no
supporting mention in the ad text as `null` (→ `needs_review`) — never as `false`.

## Two-stage pipeline

The search page truncates `description` to ~200 characters (43 of 46 sampled ended in
`...`). The full body only exists on the detail page, which exposes the same
`__NEXT_DATA__` structure with the complete `description` as HTML, plus `status` and
`endDate` (useful for delisting).

So:

1. **Triage** — one request per page of 40. Apply bedroom rule, price ceiling and city
   from the structured attributes. Costs nothing extra.
2. **Hydration** — one request per survivor, at least 2 s apart. Fetch the detail page for
   the full text, then run the extraction rules for parking cost, utilities and locker.

Without this split, evaluating the category would mean 7,941 detail requests per cycle.
With it, it is dozens.

## Rate limiting — measured, not assumed

Kijiji throttles harder than the brief's 2 s floor anticipates. Observed on 2026-08-17:

| Interval | Result |
|---|---|
| 2 s | HTTP 429 after roughly two dozen requests — search pages included, not just detail pages |
| 6 s | A 23-request cycle succeeded; the very next cycle was refused on its first request |
| 12 s | Current setting |

The 6 s result is the informative one: the limit behaves like a **rolling budget**, not a
simple gap between calls, so a cycle can succeed and still leave nothing in the tank. Two
consequences, both implemented:

1. `minIntervalMs` is 12 s, and the hydration budget per cycle is small.
2. Listings whose detail page has already been fetched are re-scored from the database
   instead of refetched (`ListingsRepository.findHydrated`). Without that, every cycle
   re-downloads every candidate it has ever seen, which is the fastest possible route back
   to a 429.

A 429 or 403 **pauses the source immediately** rather than counting toward a three-strike
budget. Spending two more requests to confirm what the source already said is how throttling
becomes a ban.

## Conduct

- Identifiable User-Agent with a contact address.
- 12 s between requests (see above); a 20-minute cron is plenty.
- 429/403 pause the source and alert; other failures back off exponentially and pause after three.
- Never work around a CAPTCHA or a login.
- Parser must fail loudly if `__APOLLO_STATE__` or the listing shape disappears. Zero
  results and "nothing new today" are indistinguishable from the outside, and that is how
  a monitor dies unnoticed.

## Listing quality traps

**Room rentals wear the clothes of apartments.** Room and shared rentals get posted in the
apartments category, and their `numberbedrooms` describes the whole unit rather than what is
actually for rent. A live example: *"Private room 736 Spadina Ave"* at $990, tagged as a
2-bedroom, whose body read "Private den (approximately 7 x 11 ft)". It scored highest of
everything found. The defence is a plausibility floor (`hard.totalRentMin`), not a text rule.

**The den is often only in the title.** *"Renovated 2 Bdm. + Den"* had no mention of a den
anywhere in its body. Extraction runs over title and body together for this reason.
