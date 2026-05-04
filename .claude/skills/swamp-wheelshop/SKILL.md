---
name: swamp-wheelshop
description: >
  Community-TS guardrail for swamp extension authors — call wheelshop BEFORE
  writing non-trivial logic in a swamp extension model to find proven npm/jsr
  libraries instead of reinventing wheels in swamp-native TypeScript. Use when
  authoring or extending models in extensions/models/ and the work involves
  any common domain — HTTP clients, retry/backoff, parsing (cron, dates, URLs,
  YAML, CSV), validation, crypto, hashing, encoding, templating, math/stats,
  rate limiting, queues, caching, diffing, etc. Triggers on "I need to write
  X", "implement retry", "parse cron", "compute hash", "build HTTP client",
  "rate limit", "before I implement", "instead of writing", "is there a
  library", "any npm package for", "wheelshop", "find a library", "search
  npm", "audit dependency".
---

# Swamp Wheelshop

Don't reinvent wheels. Before you write non-trivial logic in a swamp extension
model, ask the wheelshop whether a proven npm/jsr library already does what
you need.

## When to call wheelshop

**Always call `search` BEFORE writing logic for:**

- HTTP clients, request signing, OAuth flows
- Retry, backoff, circuit breakers, rate limiting
- Parsing (cron, dates, URLs, YAML, TOML, CSV, query strings)
- Validation, schema checking (beyond Zod's built-ins)
- Crypto, hashing, signing, JWT
- Templating, diffing, deep-equal, lodash-shaped utilities
- Queues, semaphores, p-limit-style concurrency
- Caching, memoization
- Anything that has a well-known npm package with a one-line name

**Do NOT call wheelshop for:**

- Trivial logic (1-3 lines, no edge cases)
- Domain-specific glue that has no general-purpose equivalent
- Code that wires two existing libraries together

## How to call

```bash
swamp model method run wheelshop search \
  --input intent="<plain-English description>" \
  --json
```

Optionally:

```bash
swamp model method run wheelshop search \
  --input intent="parse cron expressions" \
  --input keywords='["typescript","timezone"]' \
  --input runtime=deno \
  --input limit=3 \
  --json
```

For Deno extensions, prefer `runtime=deno` — wheelshop boosts JSR results,
which are TS-native and supply-chain-hardened by construction.

## Interpreting the response

```json
{
  "intent": "...",
  "action": "ok" | "ask_user",
  "candidates": [ { "package": "...", "version": "...", "snippet": "...", "rationale": "...", "blockers": [] } ],
  "rejected": [ { "package": "...", "blockers": ["..."] } ]
}
```

**`action: "ok"`** — Pick the top candidate. Use the provided `snippet` as a
starting point (it's a star import; switch to named imports as appropriate).
Per the project's CLAUDE.md rule #7, always pin the version: `npm:<pkg>@<ver>`.

**`action: "ask_user"`** — STOP. Every candidate failed the trust gates
(low downloads, toxic license, unmaintained, vulnerabilities, missing types,
etc.). Tell the user what was rejected and ask how to proceed:

- "Override the gates? Re-run with `unsafe=true`."
- "Build it native in this extension?"
- "Skip the feature for now?"

Do not silently fall back to a native implementation.

## Auditing a package you already have in mind

If you already know which package you want to use, audit it before adding the
import:

```bash
swamp model method run wheelshop audit \
  --input package=cron-parser \
  --input version=5.5.0 \
  --json
```

If `approved: false`, treat the same way as `ask_user` above — don't add the
dependency without addressing the blockers.

## Trust gates (defaults)

| Gate                | Threshold                                                     |
| ------------------- | ------------------------------------------------------------- |
| Weekly downloads    | >= 1,000                                                      |
| License             | MIT, Apache-2.0, BSD-2/3, ISC, 0BSD, MPL-2.0, Unlicense, CC0  |
| Last publish        | <= 24 months ago                                              |
| Maintenance score   | >= 0.4 (npms.io)                                              |
| Deprecated flag     | must be unset                                                 |
| OSV vulnerabilities | no HIGH/CRITICAL/UNKNOWN-severity advisories                  |
| Maintainer count    | >= 1                                                          |
| Type availability   | native types (`types`/`typings`/`exports.types`)              |

## Examples

**Cron parsing** — wheelshop returns `cron-parser` (3M+/week, MIT, native
types). Use it; don't write a regex.

**HTTP retries** — wheelshop returns `p-retry` or `async-retry`. Use one;
don't hand-roll a `for (let i = 0; i < n; i++) { await sleep(2 ** i * 1000); }`
loop.

**Deep-equal** — wheelshop returns `fast-deep-equal`. Use it; don't write
a recursive comparator.

**Niche internal-only protocol** — wheelshop returns `action: "ask_user"`.
Tell the user: "Found no proven library for `foobar-protocol`. Build native?"

## See also

- `swamp-extension-model` — for actually authoring the extension once you've
  picked your dependencies.
- `swamp-extension-quality` — quality scorecard for shipping the extension.
- README at `extensions/wheelshop/README.md` for full method/argument docs.
