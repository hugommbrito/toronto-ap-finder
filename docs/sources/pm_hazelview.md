# Hazelview Properties — undetermined

**Status: cannot be measured from here.** Attempted 2026-08-18, from Campina Grande, Brazil.

Not a refusal and not an approval. This source is blocked by geography rather than by policy, and
that distinction is the interesting part.

## Two different sites

`hazelview.com` answers normally — HTTP 200, `robots.txt` readable with `Disallow:` empty, meaning
nothing is disallowed at all. But it is the **investment management** arm: its homepage carries no
rental listings, and its sitemap URL is a *soft 404* (HTTP 200 serving a 404 page, which is worth
remembering — on that host a 200 proves nothing by itself).

The residential arm is `hazelviewproperties.com`, and from Brazil it answers:

```
$ curl https://www.hazelviewproperties.com/robots.txt
HTTP 403
The Amazon CloudFront distribution is configured to block access from your country.
```

## Why this is not `red`

The addendum's verdict scale is about anti-bot posture: `red` means refused, challenged, or
disallowed. This is none of those. It is a CDN geo-fence, and it says nothing whatsoever about
whether Hazelview would permit or refuse an automated reader from a Canadian address. Recording it
as `red` would be recording a conclusion nobody reached.

`robots.txt` has not been read, so nothing may be built either. The honest state is **undetermined**,
and it stays that way until someone asks from a vantage point the site will talk to.

## What this says about where the collector runs

This is the first hard evidence in the project that the geography of the fetcher matters, and it
arrived from an unexpected direction. The addendum's section 3 argued for a Canadian residential
connection on the grounds of *IP reputation* — datacenter ranges carrying low trust with anti-bot
vendors. That argument is real but speculative. This one is not: one of the three nominated sources
is simply unreachable from this country, and no amount of good conduct changes it.

Decision A1 kept the fetcher in the cloud. That remains reasonable — Kijiji and Zumper both probe
`green` and collection works — but it now carries a measurable cost, and the size of that cost
depends on something not yet checked: **which region the Railway deployment runs in.** A US or
Canadian region may well pass this fence; another may not.

The next step is not an adapter. It is one request:

1. Run `pnpm probe` from the deployment with `hazelviewproperties.com` added as a target, or simply
   `curl` its `robots.txt` from there.
2. If it answers, read the rules and the site properly, and this document gets rewritten with
   findings instead of an obstacle.
3. If it 403s from there too, the source is closed for this deployment, and that is a genuine input
   to reopening A1 rather than a theoretical one.

Until then no adapter exists for this source, and none should be written.
