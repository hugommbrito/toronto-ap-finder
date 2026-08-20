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
## Inventory, measured across all 44 buildings

The first pass counted bedroom labels and reported six of eight sampled buildings advertising a
three-bedroom. That was wrong in a way the page invites: **a building page lists the unit types
the building contains, not what can be rented.**

```
roanoke-apartments    2 Bedroom + Den    (no price)   No Vacancies
roanoke-apartments    3 Bedroom          (no price)   No Vacancies
```

A row marked `data-available="false"` with no price is a floor plan. Emitting those would fill the
feed with apartments nobody can take, and they would score *well*, because the bedroom count is
real and only the availability is not. The parser requires both conditions.

Every one of the 44 buildings in the profile's five cities has now been opened. **91 units, none
unparsable.**

| Layout | Units | At or under the $3,200 ceiling | Cheapest |
|---|---|---|---|
| Bachelor | 11 | — | $1,420 |
| 1 Bedroom | 34 | — | $1,550 |
| 1 Bedroom + Den | 3 | — | $2,095 |
| 2 Bedroom | 32 | **29** | $1,790 |
| 2 Bedroom + Den | 2 | **2** | $2,650 |
| 3 Bedroom | 9 | **9** | $2,750 |

**Forty qualifying units** — two bedrooms or more, available, inside the budget — standing at one
moment, in a segment where Kijiji is individual landlords and condo owners and where
`bedroom_rule` is the largest single source of rejections in the funnel. That is the argument for
this source, and the measured number is better than the sampled one it replaces.

By city: Scarborough 27, Toronto 25, North York 23, Etobicoke 16.

### The nine three-bedrooms, and what `excludeAreas` does to them

| Address | City | Rent | Score |
|---|---|---|---|
| 4000 Lawrence Avenue East | Scarborough | $2,795 | **78.5** |
| 30 Tuxedo Court | Scarborough | $2,750 | **75.7** |
| 1759 Victoria Park Avenue | Scarborough | $2,750 | **73.4** |
| 46-75 Goodview Road | North York | $3,100 | 61.6 |
| 15 & 25 Blackfriar | Etobicoke | $2,995 | 61.3 |
| 15 Tangreen Court | North York | $2,875 | 59.7 |
| 567 Scarborough Golf Club Road | Scarborough | $2,910 | 54.0 |
| 5 Tangreen Court | North York | $2,995 | 54.1 |
| 1216 York Mills Road | North York | $3,105 | 52.4 |

**Every three-bedroom that clears `minScore` is in Scarborough**, and the `sister` profile's
`hard.excludeAreas` refuses Scarborough. After the veto the source offers 24 qualifying units
rather than 40, and **not one surviving three-bedroom scores above 65**.

That is not an argument against the veto — it is what the veto is for, and no city allowlist could
have expressed it, since every source is entitled to label a Scarborough listing "Toronto". It is
recorded because the cost is much larger here than anywhere else: this source's best inventory and
the refused area are the same places, and whoever revisits that decision should see the number
before deciding.

## What the whole-inventory crawl caught that a sample could not

**Compound addresses shift the JSON-LD fields one key to the left.**
`7 & 9 Roanoke Road, North York, ON, M3A 1E3` arrives as `streetAddress: '7'`,
`addressLocality: '9 Roanoke Road'`, `addressRegion: 'North York'`,
`postalCode: 'ON, M3A 1E3'`. A plain address arrives correctly aligned, which is why three sampled
buildings looked right — and why eleven of the first eighty-two units were fetched, parsed, and
then rejected by the city filter for a reason that was ours, with street addresses sitting in the
city column.

The parser no longer trusts the fields individually: it joins them, removes the postal code and
province by shape rather than position, takes the city as the last segment carrying no street
number, and the street as the first segment carrying both a number and a name. That is the rule
`normalizeAddress` already applies, and it exists because sources disagree about where the city
goes.

**Entities are not decoded upstream.** One city arrived as `190 &amp; 200 Kingsview`.

**The city in the sitemap URL is not authoritative.** A property listed under `toronto-on`
redirects to `north-york-on`. Both are inside this profile's area so nothing was lost, but the
segment is routing and the address on the page is the fact. A consequence worth knowing: buildings
outside the five cities cannot be filtered out before being fetched, because their real city is
only knowable after fetching. Eleven of 44 were opened and discarded on the first sweep.

## Shape

`BuildingListingSource`, the interface Zumper already uses, for the same reason: enumeration
returns containers, opening one returns many units.

| Stage | Cost | Yield |
|---|---|---|
| Enumerate | **1 request** — the sitemap | 569 buildings with change timestamps, 44 in the 416 |
| Open one | 1 request | every rentable unit type in that building, with the building's prose |

A full backfill of 44 buildings takes about four minutes at the current pacing. Steady state
should be a handful of requests, since a building is only reopened when its `lastmod` advances,
with the seven-day `refreshEveryMs` floor underneath as a net.

## Pacing is provisional, not measured

`minIntervalMs` is 5 s. Nothing rate-limited any of this — roughly sixty requests across two days,
no 429, no challenge, no cookie set — but an absence of refusals is not a measured limit. Kijiji
sits at 12 s precisely because a gap that looked fine for one cycle was refused on the next.
Re-measure before lowering it.

## Verified end to end

A 2 Bedroom at 18 Panorama Court, Etobicoke — $2,385 with water and heat included — scored 65.7
against a `minScore` of 65 and was delivered to Telegram on 2026-08-20. Its parking is unknown,
because CAPREIT writes `Parking*` and never says what the asterisk qualifies, so the notification
carried that as an open question rather than an assumption.
