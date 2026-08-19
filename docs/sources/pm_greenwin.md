# Greenwin — not implementable

**Status: closed. Do not write an adapter.** Investigated 2026-08-18, from Campina Grande, Brazil.

Greenwin is the source the addendum nominated to be built first, and the reason it cannot be built
is not the one anybody expected. The site is friendly. Its `robots.txt` is readable, returns 200,
and disallows almost nothing:

```
User-agent: *
Disallow: /tmp
Disallow: /admin
Disallow: /mobile
```

No Cloudflare, no challenge, no fingerprinting — `server: nginx`, `x-powered-by: PleskLin`, not a
single `set-cookie`. Every listing path we would want (`/apartments-for-rent`,
`/apartments-for-rent/cities/toronto`) is permitted.

## The problem: there is no server-rendered building anywhere

`/apartments-for-rent/cities/toronto` returns 300 KB of HTML containing **zero building links**,
no JSON-LD, no `__NEXT_DATA__`, no inline state. What it contains is an unrendered client-side
template:

```html
data-latitude="<%= building.get('geocode').latitude %>"
```

The homepage is the same — even its building links are templates:

```html
<%= EnhancedSearch.config.permalinkPath %><%= building.get('permalink')... %>
```

There is no sitemap either: `/sitemap.xml` is a hard 404 and `robots.txt` declares none. So the
inventory cannot be enumerated from the site at all.

## Where the data actually lives, and why that settles it

`/scripts/main.js` (645 KB) holds a Backbone model whose URL is built like this:

```js
Building = Backbone.Model.extend({ url: function () {
  return "https://newapi.lws1.com/api/clients/" + EnhancedSearch.config.client.id + "/buildings";
}})
```

`lws1.com` is **Landlord Web Solutions** — Rentsync's former name, and the syndication platform
the addendum expected to find. Its own `robots.txt`:

```
$ curl https://newapi.lws1.com/robots.txt
User-agent: *
Disallow: /
```

Every path on the host is disallowed, for every agent. That is decisive, and it is decisive in the
plainest possible way: the permission was readable, and it says no.

**A headless browser would not change the answer.** Rendering the page in Chrome makes *the browser*
issue exactly the request `Disallow: /` refuses. Automating that is not reading a public page; it is
performing the disallowed fetch through a proxy that happens to have a UI. The project's rule is
that a source requiring that is out of scope by definition, and this is a cleaner case than the one
that rule was written for: Rentals.ca's permission could not be read, and Greenwin's can.

## This is a Rentsync finding, not a Greenwin finding

The addendum's hope for the `pm_*` family was that identifying one operator's CMS would deliver the
next several for free, because sites sharing a platform share their DOM and often their endpoint.
That reasoning holds exactly — and here it runs the other way. Any property manager whose site is
built on Rentsync will render its listings client-side from `newapi.lws1.com`, and will therefore be
closed for the same reason, without needing to be investigated one at a time.

Rentsync's own inventory is large. Treat a Rentsync marker (`assets.rentsync.com`, `lws1.com`,
`landlordwebsolutions`, a `/scripts/main.js?d=<timestamp>` bundle) as a strong prior that the
operator is closed, and find the API host before spending anything else.

**Confirmed once, by a different route.** Hazelview Properties is also Rentsync, also renders
client-side, and is also closed — but from a different host (`lift-api.rentsync.com`) and for a
different reason: that host's `robots.txt` permits everything, and what closes it is the third
party `auth_token` its bundle carries. So the prior holds, while the *reason* does not transfer.
Check each operator's actual API host; do not assume this one's `Disallow: /` speaks for it.
See `docs/sources/pm_hazelview.md`.

## What was given up

Greenwin publishes 1, 2 and 3+ bedroom inventory across the GTA, which is squarely the inventory
this profile wants and is under-represented on Kijiji and Zumper. Losing it is a real reduction in
coverage, recorded here so the gap is a known and deliberate one.

Re-checking is cheap: one request to `newapi.lws1.com/robots.txt`. If that host ever permits a path
carrying building data, the rules still have to be read and honoured before anything is built.
