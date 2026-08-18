# CAPREIT

Investigated 2026-08-18, from Campina Grande, Brazil. **Verdict: green. Not yet implemented.**

Canada's largest publicly traded apartment owner, and the one operator of the three the addendum
named that can actually be read.

## robots.txt

Fetched from `https://www.capreit.ca/robots.txt`. HTTP 200, no challenge, `server: Apache`, no
cookies set.

```
User-agent: *
Disallow: /wp-admin/
Allow: /wp-admin/admin-ajax.php

Sitemap: https://www.capreit.ca/sitemaps.xml
```

The only disallowed path is the WordPress admin, which we have no use for. Every path this adapter
would touch is permitted, and the sitemap is **declared**, which is as close to an invitation as a
site gets.

## The CMS is WordPress, and it is not shared

No Rentsync, RentCafe or Entrata markers anywhere — 97 `wp-content` references and a `generator`
meta tag. This matters for the addendum's plan: Greenwin runs Rentsync, CAPREIT runs a custom
WordPress build, and the two share nothing. The "detect the CMS and get the next three free"
strategy does not apply here, so a configuration layer over a single operator would be pure
overhead. See `docs/sources/pm_greenwin.md` for the Rentsync half of that finding.

## Enumeration is one request, and it carries a watermark

`/sitemaps.xml` is an index; `/property-sitemap1.xml` holds the inventory:

- **569 properties**, and **all 569 carry `<lastmod>`**
- the city is in the URL — `/apartments-for-rent/<city>-<prov>/<slug>/` — so the 416 can be
  filtered without spending a single request
- French duplicates exist under `/fr/appartements-a-louer/` and must be dropped

```
44 buildings in the profile's five cities, out of 569 nationally:
  north-york 13 | toronto 11 | scarborough 11 | etobicoke 9
```

`<lastmod>` is the same affordance `modified_on` gives us on Zumper, and it arrives more cheaply:
one request enumerates the whole country *and* tells us which buildings changed. A building whose
`lastmod` has not advanced since we last opened it cannot be hiding a new unit.

## What a building page carries

Server-rendered, no JavaScript needed. A `<script type="application/ld+json">` block of type
`['Apartment','Product']`:

| Field | Example |
|---|---|
| `name` | `Wellesley Apartments` |
| `address` | `100 Wellesley Street East`, Toronto, `M4Y 1H5` |
| `geo` | `43.666223, -79.378614` — **coordinates come free, no geocoder needed** |
| `offers` | `AggregateOffer`, `lowPrice: 1605`, `highPrice: 2655`, CAD |
| `description` | 155 characters of prose |
| `amenityFeature` | 17 entries |
| `petsAllowed` | `['Dog Friendly', 'Cat Friendly']` |

**`accommodationFloorPlan` is a PDF link, not structured units.** The JSON-LD describes the
building, and a price *range* over a building answers no question this profile asks — the same
lesson `docs/sources/zumper.md` records.

The units themselves are in the HTML around it: bedroom counts, per-unit prices and availability
dates (`1 Bedroom`, `2 Bedroom`, `Bachelor`, `$1,605`, `Available September 1`). Extracting them
needs markup parsing rather than a JSON key, which is the one place this source costs more than
Zumper.

## Inventory, measured — and the correction that matters

A first pass counted bedroom labels and reported that six of eight sampled buildings advertise a
three-bedroom. That number was wrong in a way worth recording, because the mistake is built into
the page: **a building page lists the unit types the building contains, not what is available.**

```
roanoke-apartments    2 Bedroom + Den    (no price)   No Vacancies
roanoke-apartments    3 Bedroom          (no price)   No Vacancies
```

A row with `No Vacancies` and no price is a floor plan, not an offer. An adapter that emitted
those would fill the feed with apartments nobody can rent, and they would score *well* — the
bedroom count is real, only the availability is not.

Re-measured across twelve of the forty-four buildings in the 416, counting only rows that are
`data-available="true"` **and** carry a price:

```
48 unit blocks seen, 32 available with a price
13 qualifying units (2 bedrooms or more, at or under the $3,200 ceiling)
10 of 12 buildings hold at least one
```

The top two rungs of the layout ladder, which is what this profile is actually short of:

```
don-view-towers               3 Bedroom        $3,105
scarborough-golf-apartments   3 Bedroom        $2,910
30-tuxedo-court-apartments    3 Bedroom        $2,750
bay-mills-apartments          2 Bedroom + Den  $2,650
```

Four buildings in twelve. If the sample holds across all forty-four, that is roughly a dozen
three-bedroom or two-plus-den offers inside the budget, standing at any one time — in a segment
where Kijiji is individual landlords and condo owners, and where `bedroom_rule` is currently the
second-largest source of rejections in the funnel.

That is the argument for this source, and it survives the correction. It is not a marginal
addition; it is the segment the two existing sources barely cover.

## The den is declared, which no other source does

`1 Bedroom + Den`, `2 Bedroom + Den` appear as their own unit types, and the enquiry link repeats
the fact in machine-readable form (`/inquiry-form/2-bedroom-den/`). Zumper publishes no prose and
therefore reports `dens: 0` for every unit, which silently demotes every two-plus-den to the
bottom rung of the ladder. Here the middle rung can actually be reached, from structured data
rather than from an extraction rule over prose.

## Shape, if it is implemented

`BuildingListingSource`, the interface Zumper already uses, and for the same reason: enumeration
returns containers, opening one returns many units.

| Stage | What it costs | What it yields |
|---|---|---|
| Enumerate | **1 request** (the sitemap) | 569 buildings with change timestamps |
| Open one | 1 request | every unit in that building, with prose |

Steady state should be a handful of requests: 44 relevant buildings, opened only when `lastmod`
advances, with the seven-day `refreshEveryMs` floor underneath.

## Open questions before writing anything

- Is the per-unit markup stable enough to parse, and does it survive across buildings? The eight
  sampled pages agree, but a fixture from three of them should drive the parser tests.
- Do the unit rows carry a locker, parking or laundry signal, or must those come from
  `amenityFeature` and the extraction layer as they do on Zumper?
- Pacing is unmeasured. Nothing rate-limited this investigation — roughly 15 requests over ten
  minutes — but that is not evidence of a limit's absence, and the floor should be measured rather
  than guessed, as it was for Kijiji.
