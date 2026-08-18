# Rentals.ca — not implemented

**Status: out of scope. Do not implement.** Checked 2026-08-18.

Section 13 of the brief: *"Respeitar robots.txt de cada fonte antes de implementar o
adapter. Se proibir, documentar e não implementar."* and *"Nunca contornar CAPTCHA, login ou
proteção anti-bot. Fonte que exige isso está fora de escopo, por definição."*

Rentals.ca fails both clauses at once, and it fails them at the first request:

```
$ curl -A "toronto-rental-monitor/1.0 (+mailto:…)" https://rentals.ca/robots.txt
HTTP 403 — <title>Just a moment...</title>
  cf_chl_opt / challenge-platform / "Enable JavaScript and cookies to continue"
```

`robots.txt` itself sits behind a Cloudflare **managed challenge**. That is decisive twice
over:

1. **The permission cannot be read.** Absent a readable `robots.txt`, there is no basis on
   which to claim any path is allowed. The brief requires checking it *before* writing the
   adapter; the check does not return an answer.
2. **Reaching any page requires defeating an anti-bot challenge**, which the brief rules out
   by definition — not as a difficulty to engineer around, but as a boundary.

No adapter exists for this source and none should be written. Re-checking later is cheap
(one request); if the challenge is ever lifted, the robots rules still have to be read and
respected before anything is built.

## What was given up

Rentals.ca aggregates a large share of Canadian purpose-built rental inventory. Losing it is
a real reduction in coverage, and Zumper only partly covers the same segment. Recorded here
so the gap is a known, deliberate one rather than an oversight.
