# Toronto Rental Monitor

Monitors Greater Toronto rental listings, scores each one against one or more configurable
tenant profiles, and notifies over Telegram only what clears the bar — with the score
breakdown attached, so the weights can be calibrated instead of guessed.

**Status: Phase 2 complete.** Kijiji runs end to end on a 20-minute cron, with confirmed
delisting, a circuit breaker that survives restarts, and a Railway deployment. Phase 3
(Rentals.ca, Zumper) is next.

## Setup

```bash
cp .env.example .env          # then fill in SCRAPER_CONTACT_EMAIL
pnpm install
docker compose up -d          # PostGIS on :5433
pnpm db:migrate
pnpm seed                     # ~1,090 daycares, 139 stations, 1 profile
pnpm test                     # 203 unit tests
pnpm verify                   # acceptance checks against the real database
pnpm cycle:dry                # one full cycle, scores everything, sends nothing
pnpm cycle                    # one full cycle, sends what clears minScore
pnpm cycle:stored             # re-score the corpus already collected, no network at all
pnpm build && pnpm start:prod # health at http://localhost:3000/health
```

`cycle:stored` is the calibration loop: change a weight, run it, and see what the current
profile makes of everything already collected. It touches no source, so a rate-limited
Kijiji never blocks scoring.

`pnpm seed` reuses the committed files under `data/seed/`. Pass `--refresh`
(`pnpm seed:refresh`) to re-download from the City of Toronto and Overpass — the diff on
those files is the review surface for upstream data changes.

Re-seeding refreshes only a profile's label and its Telegram chat id: filters and weights
are meant to be tuned in the database, and silently reverting that tuning would be worse
than useless. The chat id is the exception because it is deployment configuration rather
than a search preference — change `TELEGRAM_CHAT_ID` in `.env`, re-seed, and the new
recipient takes effect while `minScore` and `quietHours` survive untouched. Pass
`--force-profiles` to deliberately push a structural change from the code, overwriting hand
edits.

## How a profile works

Every search criterion is a row in `profiles`, stored as three `jsonb` columns and
validated with Zod on read. **There is no `if (profileId === ...)` anywhere in `src/`, and
adding a tenant must never require one.** `pnpm verify` asserts this by inserting a second
profile with a completely different bedroom rule inside a transaction, checking that the
same engine evaluates it independently, and rolling back.

- `hard` — eliminates a listing. Failures land in `rejection_log` with a machine-readable
  reason; anything indeterminate lands in `needs_review` instead. Nothing is discarded
  silently.
- `soft` — weights, normalised over whichever components could actually be evaluated.
- `notify` — recipients, minimum score, quiet hours, and `includeMap`.

`telegramChatIds` is a list: everyone on it receives every notification the profile sends.
It is still **one** notification per unit per profile — the unique index is on
`(profile_id, fingerprint)`, not on the recipient — so adding a reader fans the same
decision out to more phones rather than multiplying decisions. Set it through
`TELEGRAM_CHAT_IDS` in the environment (comma-separated) and re-seed.

`includeMap` sends a native Telegram location pin as a reply to each notification: one tap
opens the neighbourhood, street view and walking directions. It costs a second message per
listing, which is why it is a profile setting rather than fixed behaviour — nine
notifications become eighteen messages. A static map image was considered and rejected: it
cannot do any of what the pin does, and would need an API key and a second provider.

### Bedrooms are a ladder, not a threshold

Three bedrooms means a study that is not also a bedroom; 2+den puts the office in the den; a
plain 2BR puts it in the master bedroom. All three are liveable, in descending order, so
`hard.bedroomRule` is only a floor and the preference lives in `soft.bedroomTiers` —
evaluated in order, **first match wins**, so the strictest tier comes first.

```jsonc
"hard": { "bedroomRule": { "kind": "min", "beds": 2 } },   // floor: below this, no room for the child
"soft": { "bedroomTiers": [
  { "label": "3BR+ — separate office",       "rule": { "kind": "min", "beds": 3 },         "value": 1.0  },
  { "label": "2BR + den — den as office",    "rule": { "kind": "bedsPlusDen", "beds": 2 }, "value": 0.7  },
  { "label": "2BR — office in the bedroom",  "rule": { "kind": "min", "beds": 2 },         "value": 0.15 }
]}
```

Admitting plain 2BRs takes the Toronto candidate pool from ~1,700 listings to ~4,600 — by
far the largest lever available, much bigger than moving the price ceiling. The `bedroomFit`
weight of 35 is what stops that widening from flooding the feed: a plain 2BR gives up 21.3
final points, slightly more than the 21.0 points that the entire rent range is worth. So a
2BR at the target merely *ties* a 3BR at the ceiling, and an ordinary 2BR lands under
`minScore` and is never notified. Only an outstanding one gets through, which is the point.

A tier's `rule` can be any shape the bedroom expression language supports, including nested
`anyOf` — the same recursive evaluator serves the hard floor and the ladder.

### Verifying what is actually for rent

A listing site's structured fields describe the **property**; the advertisement's prose
describes the **unit**. The two diverge in two specific ways, both measured in live data:

- Landlords inflate the bedroom dropdown to reach more searches. In one sample, 5 of 15
  determinable listings disagreed with their own ad text — always with the prose reporting
  *fewer* bedrooms. `"Well Maintained 2 Bedroom + Den - Main Flr. Unit"` was filed as a
  3-bedroom, and scored on the top rung of the layout ladder.
- Rooms and shared spaces get posted in the apartments category, where the bedroom count
  belongs to the whole house. `"Private room 736 Spadina Ave"` at $990, filed as a
  2-bedroom, scored highest of everything found.

Two layers handle this. `detectLayoutConflict` (`src/listings/enrich.ts`) is deterministic
and free: it compares the ad text's bedroom count to the structured field, refuses to apply
the den upgrade when they disagree, and flags the listing. It deliberately does **not**
resolve the disagreement — the text extractor takes the first bedroom mention it finds,
which is right for "2 Bedroom + Den - Main Flr" and wrong for "3 bedroom house, renting 1
room".

Resolving it needs reading comprehension, so `ListingVerifier`
(`src/verification/listing-verifier.ts`) sends the ad to Claude Opus 5 and gets back a
structured verdict: bedrooms, dens, whether a self-contained unit is for rent, a confidence,
and the phrase the answer rests on. Three constraints keep it from becoming a second,
less predictable source of truth:

| Constraint | Why |
|---|---|
| Runs only on listings that would be notified | A handful a day, not the whole funnel — the question only matters for listings about to take up your attention |
| Can only ever *reduce* a bedroom count | Inflation is the failure being caught; a verdict that could also inflate could promote a listing on its own say-so |
| Low confidence records but never acts | The model is asked to say when it is inferring rather than reading |

**It fails open.** No API key, an error, a refusal — the listing goes through unverified
rather than being dropped, because silently losing a good listing to a failed API call is
worse than showing it with the uncertainty flagged. Every verdict lands in
`listing_verifications` with its evidence quote, whether or not it changed anything: a
correction nobody can check against the original ad is indistinguishable from a bug.

Set `ANTHROPIC_API_KEY` to enable it. Without it the pipeline behaves exactly as before.

### Rent is scored, not gated

The `sister` profile targets **CAD 2,700** with a ceiling of **3,200**. The ceiling is only
a funnel guard — a listing above target still competes, it just ranks lower:

```
rentBelowTarget = 1.0                                if total <= 2700
                  (3200 - total) / (3200 - 2700)     if 2700 < total < 3200
                  0.0                                if total >= 3200
```

A single-sided `(target - total) / target` would return 0 for everything above 2,700, which
in this market is everything — no ability to tell 2,750 from 3,150, on the axis that
matters most.

### Tuning

Weights are data. To change one:

```sql
UPDATE profiles
SET soft = jsonb_set(soft, '{weights,daycareProximity}', '25')
WHERE id = 'sister';
```

`pnpm verify` prints what the current weights are actually worth, in final points:

```
worth in final points:  500 of rent = 21.0  |  3BR over plain 2BR = 21.3  |  location = 8.4
```

Those are the numbers to argue with. Everything else in the output is a ladder — price,
layout, neighbourhood — held constant on every axis but one.

## Layout

| Path | What lives there |
|---|---|
| `src/profiles/` | Zod schemas for the profile jsonb, and the read service |
| `src/scoring/` | `bedroom-rule.ts`, `hard-filters.ts`, `scorer.ts`, `components/` |
| `src/extraction/` | Free-text rules for locker, den, parking, laundry, utilities |
| `src/geo/` | Haversine, address normalisation, fingerprinting, city matching |
| `src/verification/` | Model-read listing verdicts and the rules for acting on them |
| `src/seed/` | CKAN daycares, Overpass transit, the `sister` profile |
| `src/db/schema/` | 10 tables |
| `test/fixtures/` | Real captured payloads, so parser tests run offline |
| `src/sources/` | `source.interface.ts`, the Kijiji parser/source, the rate limiter |
| `src/pipeline/` | Triage → hydration → score → notify orchestration |
| `docs/sources/` | Per-source findings — read `kijiji.md` before touching an adapter |

Scoring maths runs in TypeScript over an in-memory snapshot of the seeded geography
(~1,090 daycares, 139 stations — under 100 KB), which is what lets every component be unit
tested without a database. PostGIS is enabled with generated `geography` columns and GIST
indexes for ad-hoc calibration queries, not for the hot path.

## Data sources

- **Child care**: City of Toronto Open Data, *Licensed Child Care Centres*. Resolved through
  `package_search` at seed time, never by a hardcoded UUID. Capacity is per age group;
  the `sister` profile counts only centres with toddler places (`TGSPACE > 0`), and scores
  CWELCC ($10/day) and municipal subsidy as their own component.
- **Transit**: Overpass (OpenStreetMap), `railway=station` with `station=subway` or
  `station=light_rail`. Toronto's 600-odd `railway=tram_stop` nodes are **streetcar** stops
  and are deliberately excluded — including them would put a "rapid transit stop" within
  400 m of nearly every downtown listing and flatten the component to a constant.
  The seed fails loudly if Line 5 (25 stations) or Line 6 (18) come back thin.

  Notifications report reachable **lines**, not station counts (`reachableLines` in
  `src/scoring/context.ts`). Daycare redundancy matters because of waiting lists; nobody
  queues for a subway, so a second stop on a line you already have adds nothing while a
  different line changes where you can go. Two listings with "1 station nearby" can mean
  Line 1 or Line 4 — the message says which, and says plainly when the answer is neither.
- **Future lines**: hand-seeded, because OSM does not yet carry them as station nodes in
  Toronto. Coordinates are intersection-level approximations; acceptable only because
  `transitFuture` carries a weight of 3 out of 140 and can never substitute for an
  operational line.

## Data attribution

The files under `data/seed/` are redistributed from two open datasets, and both licences
require attribution:

- **`daycares.json`** — *Licensed Child Care Centres*, City of Toronto Open Data, used under
  the [Open Government Licence – Toronto](https://open.toronto.ca/open-data-licence/).
- **`transit-stations.json`** — derived from [OpenStreetMap](https://www.openstreetmap.org/)
  via the Overpass API, © OpenStreetMap contributors, available under the
  [Open Database Licence](https://opendatacommons.org/licenses/odbl/). Stations for lines
  still under construction are hand-seeded and are not OSM-derived.

The fixtures under `test/fixtures/kijiji/` are captured advertisement payloads, kept so the
parser tests run offline and deterministically. They are test material, not a dataset.

## Conduct

Personal use, low volume, but still: `robots.txt` respected per source (see
`docs/sources/`), identifiable User-Agent with a contact address, a per-source minimum gap
between requests (12 s for Kijiji — measured, not guessed), and an immediate pause on
429/403 rather than a retry. No CAPTCHA or login is ever worked around, and
collected data is not redistributed.

## The pipeline

Two stages, because the search page truncates the ad body at ~200 characters and Kijiji
throttles hard (see `docs/sources/kijiji.md`).

1. **Triage** — one request per page of 40. Bedroom rule, price band and city are decided
   from structured attributes alone, at no extra cost. A `reject` stops here and is logged;
   a `review` means something is unknown, which is exactly what hydration resolves.
2. **Hydration** — one request per survivor, at least 12 s apart, capped by a per-cycle
   budget. Anything already hydrated is re-scored from the database rather than refetched.

Both `rejection_log` and `needs_review` are written on every cycle, so `pnpm cycle` prints a
funnel you can read:

```
rejected at triage (structured data only):
  bedroom_rule             38
  rent_ceiling             33
  daycare_coverage         20
```

That table is the instrument. It is what showed a 900 m hard transit limit was killing 41%
of everything — more than any other filter, for the criterion this profile cares least
about — which is why transit is now scored rather than cut.

## Running it

A cycle runs every 20 minutes (`SchedulerService`). Set `CYCLE_ENABLED=false` to run the
service without polling and drive cycles by hand instead.

Each cycle walks 2 search pages, hydrates at most 20 new listings, and spends 3 requests
re-checking listings it has already surfaced. That is about 25 requests per cycle at a
12-second floor — roughly one request every three minutes across the day.

**Delisting is confirmed, never presumed.** An ad drops off the first pages within days
while remaining perfectly available, so absence proves nothing; only the ad's own `status`
does. The re-check pass asks, least-recently-confirmed first.

**A paused source alerts once.** Empty cycles look exactly like a quiet market, which is the
failure most likely to go unnoticed for a week, so a 429 sends a Telegram message and shows
up as `degraded` on `/health`. The gap between cycles is the backoff: after 20 minutes the
circuit resets itself.

## Deploying to Railway

```bash
railway init
railway add --database postgres
railway variables --set "TELEGRAM_BOT_TOKEN=..." \
                  --set "TELEGRAM_CHAT_IDS=100000001,100000002" \
                  --set "SCRAPER_CONTACT_EMAIL=you@example.com"
railway up
```

`DATABASE_URL` and `PORT` are injected by Railway. The Dockerfile is the build; boot runs
migrations and, on an empty database, seeds geography and profiles from the committed files
under `data/seed/` — so a cold start needs no external service.

**PostGIS is optional and Railway's default Postgres does not have it.** Migration `0001`
checks `pg_available_extensions` and skips the geography columns when it is absent, because
nothing in `src/` reads them: scoring runs in memory, and the columns exist only for ad-hoc
spatial queries. Verified by cold-starting the image against a plain `postgres:16-alpine` —
9 tables, 0 geography columns, 1,090 daycares, no errors. Use a PostGIS template if you want
those queries back.

Run one replica. Migrations run at boot without an advisory lock, so concurrent instances
would race.

## What is next

- **Phase 3** — Rentals.ca and Zumper; prove cross-source dedup on real data.
- **Phase 4** — second profile, with zero lines of code changed.
