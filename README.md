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
pnpm test                     # 376 tests (16 need a database, skipped without one)
pnpm verify                   # acceptance checks against the real database
pnpm probe                    # measures what each source does when we knock
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

### A refused area is not a city

`hard.excludeAreas` is a veto, and it cannot be folded into `hard.cities`. The `sister`
profile refuses **Scarborough, East York and Brampton** outright — no price makes them
acceptable, so they are cut rather than ranked.

Removing them from `cities` would achieve nothing. Scarborough and East York have been the
same municipality as Toronto since the 1998 amalgamation, so a source calling a listing
"Scarborough" and one calling it "Toronto" are both telling the truth — and `cityMatches`
agrees with both on purpose, because that is what "anywhere in the 416" means. A name-based
allowlist is therefore structurally unable to express "the 416 except Scarborough".

So the cut is decided by **position**, against the real 1998 boundaries in
`data/seed/municipal-boundaries.json` (`src/geo/areas.ts`). On Danforth Avenue the answer
turns on about 300 m of Victoria Park Avenue, which is why these are actual outlines and not
bounding boxes. The label is still checked first — it is free, and it is the only signal a
listing without coordinates has. Brampton needs no geometry at all: it is its own
municipality, so its own name identifies it.

A listing whose area **cannot** be determined — no coordinates, and a label that says only
Toronto — goes to `needs_review`, never to `pass`. The same is true if the boundary file
goes missing: `pnpm verify` checks two known addresses inside Scarborough and East York for
exactly that reason. The worst this filter can do is hold a listing back; it cannot quietly
deliver the one thing the profile said no to.

Areas are data like everything else. On a deployment, `excludeAreas` is a field that did
not exist when the row was seeded, so it is added with the sync tool below:

```
node dist/profiles/sync-profile.js --apply
```

Or, where there is a `psql`:

```sql
UPDATE profiles
SET hard = jsonb_set(hard, '{excludeAreas}', '["Scarborough", "East York", "Brampton"]')
WHERE id = 'sister';
```

Valid names are the six former municipalities — `Scarborough`, `North York`, `East York`,
`Etobicoke`, `York`, `Old Toronto` — plus any separate municipality by name. Neighbourhoods
below that level (Riverdale, Liberty Village) have no boundary data and cannot be cut this
way.

### Tuning

Weights are data. To change one:

```sql
UPDATE profiles
SET soft = jsonb_set(soft, '{weights,daycareProximity}', '25')
WHERE id = 'sister';
```

There is no `psql` in the deployment — the runtime image is `node:22-alpine` with the
production dependencies and `dist/` — so a **structural** change, a field the stored row
does not have at all, goes through:

```
node dist/profiles/sync-profile.js            # dry run: says what it would do
node dist/profiles/sync-profile.js --apply     # adds only the keys the row is missing
node dist/profiles/sync-profile.js --apply --overwrite hard.cities
```

It splits the two cases `pnpm seed --force-profiles` conflates. A key the row does not have
is a field added in code, with no tuning to lose, so it is added. A key that exists and
disagrees is tuning or a decision, and is left exactly as it is unless named with
`--overwrite`. Keys that exist only in the database are never touched.

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
| `src/db/schema/` | 13 tables |
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

The files under `data/seed/` are redistributed from open datasets, and the licences
require attribution:

- **`daycares.json`** — *Licensed Child Care Centres*, City of Toronto Open Data, used under
  the [Open Government Licence – Toronto](https://open.toronto.ca/open-data-licence/).
- **`municipal-boundaries.json`** — *Former Municipality Boundaries*, City of Toronto Open
  Data, used under the [Open Government Licence – Toronto](https://open.toronto.ca/open-data-licence/).
  Simplified to a 25 m tolerance, which is far below anything that can change an answer:
  these lines run down the middle of arterial roads and rivers.
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

`robots.txt` used to be checked only by hand, once, per source. It is now re-read weekly and
evaluated against the exact URL the adapter requests — see **Source policy** below.

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
does. The re-check pass asks its **own source's** listings, least-recently-confirmed first.

Both halves of that sentence were false until they were measured in production, and the symptom
was a lie: every Kijiji cycle failed with *"no `__NEXT_DATA__` script tag — the page structure
changed"*, which was true of nothing. `findForRecheck` had no source filter, so a Zumper listing
was fetched from zumper.com by the Kijiji adapter, through Kijiji's rate limiter, and parsed for a
block Zumper has never had. And `DISTINCT ON (id)` obliges Postgres to sort by `id` first, so
"least-recently-confirmed" was unreachable: the same random-but-stable uuids came back every
cycle, which is why one unreadable listing could fail every run indefinitely and why nothing was
ever confirmed delisted. `EXISTS` states the requirement without the duplicate rows `DISTINCT ON`
was compensating for, and a failed re-check now counts against `missed_sweeps` — after three it
leaves the queue and is flagged for review, never marked delisted, because failing to read an
advertisement is not evidence about the advertisement.

`GET /operations` is what surfaced this. Without it the whole thing reads as a quiet market.

**A paused source alerts once, per source.** Empty cycles look exactly like a quiet market, which
is the failure most likely to go unnoticed for a week, so a 429 sends a Telegram message and shows
up as `degraded` on `/health`. The gap between cycles is the backoff: after 20 minutes the
circuit resets itself. Once per pause and not once per cycle — but a second source going down
during the first one's outage is news, and is still said.

**And if no cycle finishes at all, that is also said.** A watchdog checks every fifteen minutes and
raises a Telegram alert when nothing has completed in ninety, then says so again when cycles
resume. It stays quiet when `CYCLE_ENABLED=false`, where silence is the operator's own decision,
and when no cycle has ever run, because a fresh install is not an outage.

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

## Migrations

**Migrations are hand-written, and the journal is the list.** `migrate()` reads
`src/db/migrations/meta/_journal.json` and runs what it names — a `.sql` file the journal does not
mention simply never executes.

That failed once, silently. `0006_source_buildings.sql` was committed without its journal entry,
so `source_buildings` was missing from every database the migrator created; the dev database only
had the table because it was created by hand. A fresh deployment would have taken the Zumper cycle
down on its first upsert. `src/db/migrations.spec.ts` now fails when a `.sql` file has no entry,
when an entry has no file, when `idx` or `when` go out of order, and when a table declared in
`src/db/schema/` never appears in any migration.

`drizzle-kit generate` is **not** trustworthy in this repo: `meta/` holds snapshots for `0000` and
`0001` only, so it would diff against a five-migration-old state. The script is named
`db:generate:unsafe` to say so. Use it as a draft generator if you like, then rewrite the output in
the house style before it lands:

- `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`, so re-running is a no-op
- a comment block at the top saying *why*, not what
- a `DO $$` guard for anything that may be absent on the target — `0001_postgis.sql` is the model,
  because Railway's default Postgres has no PostGIS
- the data change travels with the schema change when a column needs backfilling; `0002` and `0005`
  both migrate `profiles` jsonb alongside the DDL

## Source policy

**Measure before writing an adapter.** A source's level of protection changes without notice, and a
scraping vendor's blog is marketing rather than a technical reference. `pnpm probe` makes two
requests per source — `robots.txt`, then the page the adapter actually fetches — and records a
verdict in `source_policy`:

| Verdict | Meaning | What it licenses |
|---|---|---|
| `green` | 200, and a known listing marker matched the raw HTML | an adapter of `undici` plus a parser |
| `yellow` | 200, but the content is not in the initial HTML | look for a published JSON endpoint **before** anyone reaches for a headless browser |
| `red` | refused, challenged, or disallowed by `robots.txt` | **nothing. The source is closed.** |

`red` is not an invitation to investigate a bypass. Keeping a workaround alive is continuous work
against a target that changes weekly, on a project whose useful life ends when a lease is signed.

Two design decisions worth knowing:

- **The primary key is `(source_id, probed_from)`**, not the source alone. Anti-bot systems keep
  reputation by IP range, so "will this source talk to us?" is a fact about the pair. Keyed on the
  source alone, a probe run from a laptop would overwrite the deployment's verdict with a friendlier
  one — inverting the one fact the table exists to record. A local run shows up as
  `local:<hostname>`, the deployment as `railway:<env>:<region>`.
- **Verdicts are advisory.** Nothing in the pipeline reads one to decide whether to fetch. A
  transient 503 must not be able to silence the monitor for a week; `CYCLE_ENABLED=false` is still
  the switch, and a `red` on a source already running is an operator's decision. They surface on
  `/health` and, when a verdict *degrades*, once on Telegram.

It runs weekly (Mondays 04:17, off the rhythm of the collection cycles); `PROBE_ENABLED=false`
turns it off. Cookie and header **names** are stored, never values — a kept `cf_clearance` would be
a retained challenge token, which is the first step of working around a challenge rather than
respecting it.

Rentals.ca is deliberately not probed: it is a documented refusal, and re-requesting a site that
has already answered is not a measurement worth taking.

## Operations

`/health` answers "is this process up". It cannot answer "has the work been getting done", and
those are different failures: a monitor that is perfectly healthy and has collected nothing for two
days looks fine to a liveness check and is completely broken.

`GET /operations` answers the second one, over a window (`?hours=24`, clamped to 30 days):

```bash
curl -H "Authorization: Bearer $OPERATIONS_TOKEN" \
     "https://<deployment>/operations?hours=48"
```

- **per source** — cycles run, how many failed, paused right now and why, when it last succeeded,
  the last error, and the current `source_policy` verdict. Keyed on the registry rather than on the
  runs, so a source that did not run *at all* is visible instead of absent.
- **totals** — seen, new, hydrated, scored, notified, delisted, summed across the window.
- **the funnel** — rejection reasons aggregated from `rejection_log`, which is the instrument that
  showed a 900 m transit limit was killing 41% of everything.
- **runs** — every cycle with its duration, outcome and errors.

It needs `OPERATIONS_TOKEN`. **Unset closes the route rather than opening it** (`503`): the report
carries addresses, prices and failure detail, and this service is meant to be private.

The history lives in `cycle_runs`, one row per cycle per source, so it survives the redeploys that
used to erase it — which happened on every push, and again on each of Railway's five restart
attempts, exactly when something had gone wrong enough to cause one.

This route is also the trip-wire for the collector contingency: moving the fetcher onto a
residential connection is worth doing when, and only when, collection from the cloud starts
failing. This is where that becomes visible.

## Sources

| Source | Status | Granularity |
|---|---|---|
| Kijiji | live | one advertisement, one unit |
| Zumper | live | search returns **buildings**; one request opens all their floorplans |
| Rentals.ca | **refused** | `robots.txt` itself sits behind a Cloudflare challenge — see [docs/sources/rentals-ca.md](docs/sources/rentals-ca.md) |
| CAPREIT | live | one sitemap request enumerates 569 properties with `<lastmod>`, 44 in the 416; 91 units measured, 40 of them 2BR+ inside the budget. The only source here that declares a den — see [docs/sources/pm_capreit.md](docs/sources/pm_capreit.md) |
| Greenwin | **closed** | site renders client-side from `newapi.lws1.com`, whose `robots.txt` is `Disallow: /` — see [docs/sources/pm_greenwin.md](docs/sources/pm_greenwin.md) |
| Hazelview | **closed** | Rentsync again, via `lift-api.rentsync.com` behind a third party's `auth_token`. Both robots files permit us; the credential does not — see [docs/sources/pm_hazelview.md](docs/sources/pm_hazelview.md) |

Zumper runs on its own cron, offset ten minutes from the Kijiji one. Its budget counts
buildings rather than listings: four opened buildings produced 174 units in one measured run.
Set `BUILDING_CYCLE_ENABLED=false` to turn it off without touching the Kijiji cycle.

**A building becomes due again in three ways**: it has never been opened, its source says it
changed, or it has aged past that source's `refreshEveryMs`. The third exists because the first
two are not enough. A source that publishes no last-modified — which is every property manager —
would otherwise stay permanently due, and since Postgres sorts nulls last, the buildings already
opened would outrank the ones never opened and the rest of the inventory would never be reached,
while the log printed a healthy count of buildings opened each cycle. The same rule covers the
opposite failure: a source that stops publishing the field freezes silently, so seven days is the
longest Zumper may go unchecked regardless.

Cross-source deduplication is proven by test but not yet by production data: the two sources
share no buildings at all, and the nearest pair of listings is 518 m apart. Details and
measurements in [docs/sources/zumper.md](docs/sources/zumper.md).

## What is next

- **Phase 4** — second profile, with zero lines of code changed.
