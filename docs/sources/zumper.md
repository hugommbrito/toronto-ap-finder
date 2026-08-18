# Zumper

Checked 2026-08-18. Implemented.

## robots.txt

Readable, no challenge, HTTP 200. Our adapter matches `user-agent: *`.

**`crawl-delay` does not bind us.** It appears twice, under `ImagesiftBot` and `ias-va`
only; the `*` group declares none. We pace ourselves anyway — see below.

Relevant `disallow` entries under `*`, and how each is honoured:

| Rule | Consequence |
|---|---|
| `/api`, `/json`, `/listing-feed`, `/map` | Every JSON endpoint is off limits. We read the rendered page instead. |
| `/*?bedrooms=`, `/*?bathrooms=`, `/*?loc=`, `/*?box=`, `/*?s=` | No search filtering by query string. We fetch the unfiltered city page and filter locally. |
| `/apartment-for-rent/`, `/house-for-rent/`, `/condo-for-rent/` | Singular forms. Not paths we use. |
| `/houses/*-*/*`, `/condos/*-*/*` | Not paths we use. |

Paths we do use, none of which appear in any `disallow`:

- `/apartments-for-rent/toronto-on` and `?page=N` — the plural form, distinct from the
  disallowed singular `/apartment-for-rent/`. `page` is not among the disallowed parameters.
- `/apartment-buildings/p<id>/<slug>` — building pages.

`sitemap: https://www.zumper.com/sitemap.xml.gz` is declared but unused; the city page
already enumerates the inventory.

## The shape of the data, and why this source is not like Kijiji

**A Zumper search result is a building, not a unit.** Measured across 90 unique buildings:
**0 of them** advertise a single unit. Every entry is a price *range* over many floorplans —
median spread **$1,600**, largest $4,670, up to 100 floorplans in one entry.

```
The Diamond            $2169-3809 | 1-3BR | 28 floorplans
Leaside Towers         $1600-4500 | 1-3BR |  9 floorplans
```

Nothing scoreable can be built from that. "Is this a 3BR at or under $2,700?" has no answer
at building level. So the two stages carry different meanings here:

| Stage | Kijiji | Zumper |
|---|---|---|
| Triage, 1 request | ~40 **units** | 50 **buildings** |
| Hydration, 1 request | 1 unit's description | **all floorplans** in one building |

Zumper hydration is one-to-many: `floorplan_listings` yielded 38 units for The Diamond in a
single request. This is why `ListingSource` carries a `granularity` field — the pipeline has
to know that a Zumper triage entry is a container to be opened, not a listing to be scored.

**A floorplan is not a specific apartment.** "Diamond 2 - Plan C, $2,189, 1BR" may stand for
several identical units. It is still actionable — you can ask the building about that plan —
but it is a class of unit, and the fingerprint treats it as one.

## Where the data lives

Not `__NEXT_DATA__`. Both pages carry a large inline `<script>` holding the app state:

- Search page → `"listables":{"listables":[…]}` — `listing_id`, `address`, `city`, `lat`,
  `lng`, `min_price`/`max_price`, `min_bedrooms`/`max_bedrooms`, `floorplan_count`,
  `building_amenity_tags`, `modified_on`, `url`.
- Building page → `"floorplan_listings":[…]` — per unit: `price`, `bedrooms`, `bathrooms`,
  `description`, `date_available`, `amenity_tags`, `square_feet`.

A `SearchResultsPage` JSON-LD block also exists and is cleaner, but it carries **neither
price nor coordinates** and its `numberOfBedrooms` is a single number where the app state has
the real range. It is not used.

### The sixteen decoys

The search page contains **sixteen** keys named `listables`. The first several belong to
unrelated state slices — `affordabilityCalculator`, `agentProfile` — and are empty arrays.
Taking the first one that parses returns `[]`, which is indistinguishable from a city with no
rentals in it. `extractStateArray` therefore requires a predicate describing a real element
(a building has `listing_id` and coordinates; a floorplan has `listing_id` and a layout).

This was not caught by the fixture, which had one `listables` key; it was caught by the first
live run returning zero buildings. The fixture now carries the decoys.

### There is no advertisement text

Measured on a real building: `description` and `short_description` were empty for **all 38**
floorplans, and the building's own description is 192 characters of boilerplate — *"View
detailed information about The Diamond rental apartments located at…"*. Zumper publishes no
prose at all.

Three consequences, all of them load-bearing:

1. **`rawText` stays null.** Both fields are still read, so the day Zumper fills them we get
   them for free, but nothing is invented in the meantime.
2. **The model verifier never runs on this source.** It already refuses a listing with no
   text (`listing has no advertisement text`) and fails open. Feeding it an empty body would
   invite exactly the fabrication it exists to prevent.
3. **Every unit reports `dens: 0`.** A 2BR+den is scored as a plain 2BR, one tier lower than
   it deserves. That error is one-directional by construction — it undersells a unit, never
   oversells one — which is the opposite of the 1BR+den-filed-as-2BR problem that made the
   verifier necessary in the first place.

### Fields the unit record does not have

`parking`, `utilities` and `den` have no structured field at floorplan level. They come from
`description` through the same extraction layer Kijiji uses. Building-level
`building_amenity_tags` does name parking explicitly ("Garage Parking", "Underground
Parking"), and that is read as a building-wide fact.

**Coordinates are building-level.** Every floorplan inherits its building's `lat`/`lng`,
which is correct — they are in the same building.

## Pacing

`minIntervalMs` is **6 s**, half of Kijiji's 12 s. Two reasons, neither of them "because we
can": Zumper returned no 429 during this investigation, and its hydration is 38× more
productive per request, so a smaller number of requests does much more work.

**The cheap pre-filter does not work.** Filtering buildings by `min_price <= ceiling` and
`max_bedrooms >= 2` keeps **87 of 90** — `min_price` is always the cheapest studio, so nearly
every building passes. Sweeping all 229 Toronto buildings would cost ~229 hydration requests.

What makes it affordable is `modified_on`, which triage gives away for free: a building whose
`modified_on` has not advanced since we last opened it cannot contain a new floorplan. Steady
state is a handful of requests; only the first backfill is expensive, and it is spread across
cycles by the hydration budget.

## Inventory

229 buildings in Toronto, ~3,500 floorplans. Pagination is `?page=N`, 50 per page.

**Pages overlap.** Page 1 and page 2 shared 10 of 100 entries — featured placements repeat.
Deduplicate by `listing_id` across pages; do not assume pages partition the inventory.

## Deduplication, measured

On a real corpus of 174 Kijiji listings and 174 Zumper units:

| | Listings | Fingerprints |
|---|---|---|
| Kijiji | 174 | 173 |
| Zumper | 174 | **79** |

**Within Zumper the collapse is 2.2×**, and it is the intended one: 432 Cherry St advertises
three separate 2BR floorplans at $3,713, which is one offering to anyone deciding where to
live, and one notification.

**Across the two sources there were zero collisions** — and zero is the honest result, not a
failure. The two sources do not list the same buildings: no street address appears in both,
and the closest a Kijiji listing comes to a Zumper one is **518 m**. Kijiji is individual
landlords and condo owners; Zumper is purpose-built rental buildings under professional
management. The inventories are complementary, not overlapping.

So the cross-source path is proven by construction and by unit test
(`src/listings/cross-source-dedup.spec.ts`), not by production data — there has been nothing
to deduplicate. Worth re-checking if a third source is ever added, since a condo aggregator
would overlap both.
