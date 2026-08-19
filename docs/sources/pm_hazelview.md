# Hazelview Properties — closed

**Status: closed. Do not write an adapter.** Investigated 2026-08-18 from Campina Grande, Brazil,
and concluded 2026-08-19 from the Railway deployment in `us-east4`.

Closed on a credential, not on `robots.txt` — which is unusual enough here to be worth stating
before anything else, because every rule that could have settled it permits us.

## It could not be measured from Brazil at all

`hazelviewproperties.com` answered `403` from CloudFront: *"The Amazon CloudFront distribution is
configured to block access from your country."* That is a geo-fence, not an anti-bot posture, and
it says nothing about whether the site would refuse an automated reader from elsewhere. Recorded
at the time as **undetermined**, deliberately, rather than as a refusal nobody had established.

From the deployment it answers normally. Worth keeping as a finding in its own right: the
datacenter address in `us-east4` sees a source the residential connection in Brazil cannot. The
addendum's section 3 argued for moving collection *onto* a residential line; for this source the
cloud is the better vantage point.

(The investment-management site at `hazelview.com` is a different property with no rental
listings, and its `/sitemap.xml` is a **soft 404** — HTTP 200 serving a 404 page. On that host a
200 proves nothing by itself.)

## Everything that could have refused us, permits us

`https://www.hazelviewproperties.com/robots.txt` — HTTP 200, readable, and narrow:

```
User-agent: *
Disallow: /tmp
Disallow: /admin
Disallow: /mobile
Disallow: /properties/233-kennedy-street-medical-arts
Disallow: /residential/233-kennedy-street-medical-arts
Disallow: /properties/cx
Disallow: /residential/cx
```

Two individual properties excluded by hand, which is a site owner who understands the file. The
listing paths themselves are permitted.

Those first three rules are byte-identical to Greenwin's, in the same order — a Rentsync
fingerprint, later confirmed by `assets.rentsync.com` assets and a `/scripts/main.js?d=<timestamp>`
bundle in the same shape.

## The pages carry nothing

`/properties` and `/residential` are 57 KB application shells:

| Signal | Result |
|---|---|
| prices in the raw HTML | 0 |
| links to individual buildings | 0 |
| `__NEXT_DATA__`, JSON-LD | absent |
| visible text | navigation only — *About Us, Careers, Contact, Resident Portal* |

The first attempt to count building links used a regex assuming `/properties/<slug>`, so its zero
proved nothing; the page turned out to link only to marketing pages, which does.

## Where the listings come from

`/scripts/main.js` (754 KB) fetches them from:

```
https://lift-api.rentsync.com/v2/search?auth_token=<embedded in the bundle>
```

A different host from Greenwin's `newapi.lws1.com`, but the same company — `theliftsystem.com`,
`lws1.com` and `rentsync.com` are one lineage, and `feeds.lws1.com` appears in the same bundle.

**And that host's `robots.txt` permits everything.** It is the stock Rails file with every line
commented out, including the ban it describes:

```
# To ban all spiders from the entire site uncomment the next two lines:
# User-Agent: *
# Disallow: /
```

Recorded in full so that nobody re-runs this investigation hoping robots will settle it. It does
not. Greenwin was closed by a `Disallow: /`; this is the opposite case.

## Why it is closed anyway

The `auth_token` is an authentication parameter identifying **Hazelview's account** on Rentsync.
It is not secret — it ships to every browser that loads the page — but it is not ours, and using it
means making requests as their website.

The argument for using it is real and worth stating: a visitor's browser makes that exact request
with that exact token, so an automated client doing the same thing at lower volume is doing what
the site's own front end does.

What settles it is that **there is no honest way to do it**. Sent with this project's real
User-Agent, Rentsync sees an unidentified client presenting one of its customers' credentials —
which reads as credential misuse from the only side that matters, however benign the intent. Sent
with a browser's User-Agent, we have abandoned the rule this project holds itself to. Section 7's
reasoning — *"whoever wants to block will block anyway, and whoever doesn't would rather know who
they are talking to"* — has no good answer here.

Two smaller costs, for completeness: the token can be rotated without notice, which is the ongoing
maintenance the addendum's `red` rule exists to avoid; and our volume would be counted against
Hazelview's account rather than our own.

Asking Rentsync for a token of our own is the legitimate route and remains open. It was not taken
because this project's useful life ends when a lease is signed.

## What this settles beyond Hazelview

Two Rentsync operators, two different API hosts, two different reasons — both closed. The
addendum hoped that identifying a CMS would deliver the next operators for free, and it does,
though not in the direction it expected: a Rentsync marker is a strong prior that the operator's
listings are unreachable on acceptable terms.

That is worth real money in time. Minto, Realstar, Greenrock, Medallion, Starlight and the rest of
the candidate list can be triaged by checking for `assets.rentsync.com` and a
`/scripts/main.js?d=` bundle before anything else is spent on them.
