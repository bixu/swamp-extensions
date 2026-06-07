---
name: swamp-wheelshop
description: >
  Trust-gate auditor for npm/jsr packages used inside swamp extension models.
  Use whenever you'd otherwise hand-roll non-trivial logic in extensions/models/
  AND `swamp extension search <query>` has not surfaced a trusted swamp
  extension that already does the job. The bar for "non-trivial" is low —
  default to calling wheelshop and only skip when the logic is genuinely
  trivial. You handle registry search and semantic relevance; wheelshop scores
  candidates against published trust gates (license, downloads, vulnerabilities,
  maintenance, types) and returns approval verdicts. Triggers on "I need to
  write X", "implement", "parse", "compute", "build", "before I implement",
  "instead of writing", "is there a library", "any npm package", "wheelshop",
  "find a library", "audit dependency", "evaluate package", "what library
  should I use".
---

# Swamp Wheelshop

Don't reinvent wheels. For any swamp extension model that needs functionality
covered by a common npm/jsr package, run candidates through wheelshop's
trust-gate audit before adding the import.

## Division of labour

Wheelshop is a **trust-gate auditor**, not a search engine. Discovery and
semantic relevance are your job; gating and scoring are wheelshop's job.

| Step                                                                     | Who does it |
| ------------------------------------------------------------------------ | ----------- |
| Search the npm/jsr registry for the intent                               | You         |
| Read package descriptions and pick semantically relevant candidates      | You         |
| Run trust gates (license, vulns, downloads, recency, types, maintainers) | Wheelshop   |
| Compute quality score, return verdict + snippet                          | Wheelshop   |
| Pick the top approved candidate and pin its version                      | You         |

This split exists because LLMs are good at reading prose and bad at being
trustworthy about supply-chain facts. Wheelshop's gate engine is deterministic,
cacheable, and auditable.

## When to use wheelshop

Default to calling wheelshop. Before writing **any non-trivial logic** inside
`extensions/models/*.ts`:

1. First, search for a trusted swamp extension
   (`swamp extension search <query>`, then `swamp model type search <query>`).
2. If nothing trusted covers the domain, call wheelshop.

The bar for "non-trivial" is low. If a 5-line implementation has _any_ edge case
— Unicode, timezone, retry semantics, base64 padding, URL escaping, HTTP
redirect handling, race conditions, character classes — it qualifies. When in
doubt, call wheelshop.

**Skip wheelshop only for:**

- Trivial logic (1-3 lines, no edge cases)
- Code that wires two existing libraries together

## The flow

### Step 1 — search registries directly

```bash
# npm registry search (free, no auth, returns popularity/quality signals)
curl -s 'https://registry.npmjs.org/-/v1/search?text=<query>&size=25' | jq

# jsr (Deno-native, supply-chain-hardened by construction; prefer for runtime=deno)
curl -s 'https://jsr.io/api/packages?query=<query>&limit=25' | jq
```

Use the intent's _specific_ terms, not the full English sentence. For "HTTP
client with retry and exponential backoff", search `retry backoff` or
`exponential-backoff`, not the full phrase. npm's search is a literal multi-word
matcher; verbose queries return nothing.

Run two or three focused queries rather than one verbose one.

### Step 2 — pick candidates by reading descriptions

Look at the top 10-20 results. Select 3-6 candidates by **semantic fit** with
the intent. Criteria:

- **Canonical names beat generic ones.** `p-retry` over `my-retry-lib`,
  `cron-parser` over `cron-utils-wrapper`.
- **Description matches the actual operation.** For retry, look for words like
  "retry", "backoff", "attempts", "exponential". Reject packages whose
  description is about a different operation (e.g. `urql/exchange-auth` is not a
  generic OAuth helper).
- **Framework coupling is a deal-breaker** unless you want that framework in
  your extension. Skip `nestjs-*`, `vue-*`, `react-*` etc. for runtime
  utilities.
- **Recent activity in the description is fine; recent activity at the registry
  level is gated by wheelshop.** Don't pre-screen on dates.

If you can't find 2+ semantically-fit candidates, stop and ask the user before
continuing.

### Step 3 — hand the list to wheelshop

```bash
swamp model method run wheelshop evaluate \
  --input packages='[{"name":"p-retry"},{"name":"async-retry"},{"name":"got"}]' \
  --input runtime=deno \
  --json
```

- `packages` — array of `{name, version?}`. If `version` is omitted, wheelshop
  audits the latest published version.
- `runtime` — `deno` | `node` | `both`. Affects scoring (JSR candidates boosted
  for `deno` and `both`).

### Step 4 — interpret the verdict

```json
{
  "action": "ok",
  "candidates": [
    {
      "package": "p-retry",
      "version": "6.2.1",
      "registry": "npm",
      "approved": true,
      "score": 5.94,
      "rationale": "...",
      "snippet": "import * as p_retry from \"npm:p-retry@6.2.1\";",
      "blockers": []
    },
    {
      "package": "got",
      "version": "14.4.3",
      "registry": "npm",
      "approved": false,
      "blockers": ["no-types"],
      "snippet": null
    }
  ]
}
```

- **`action: "ok"`** — at least one candidate passed all gates. Pick the
  top-ranked `approved: true` entry. Use its `snippet` as your import line (it's
  a star import; switch to named imports as appropriate). The snippet pins the
  version.
- **`action: "ask_user"`** — every candidate failed the gates. Tell the user
  which gates each candidate failed and ask:
  - "Override the gates? Re-run with `unsafe=true`."
  - "Suggest different candidates?" (give them the descriptions)
  - "Build it native in this extension?"
  - "Skip the feature?"
  - Do not silently fall back to a native implementation.

## Trust gates (defaults)

| Gate                | Threshold                                                    |
| ------------------- | ------------------------------------------------------------ |
| Weekly downloads    | >= 1,000                                                     |
| License             | MIT, Apache-2.0, BSD-2/3, ISC, 0BSD, MPL-2.0, Unlicense, CC0 |
| Last publish        | <= 24 months ago                                             |
| Maintenance score   | >= 0.4 (npms.io)                                             |
| Deprecated flag     | must be unset                                                |
| OSV vulnerabilities | no HIGH/CRITICAL/UNKNOWN-severity advisories                 |
| Maintainer count    | >= 1                                                         |
| Type availability   | native types (`types`/`typings`/`exports.types`)             |

Override any gate by passing `unsafe=true` — but only with explicit user
approval, and never silently.

## Examples

### Cron parsing

```bash
curl -s 'https://registry.npmjs.org/-/v1/search?text=cron+parser&size=10' | jq '.objects[].package | {name, description}'
# pick: cron-parser, cronstrue, croner
swamp model method run wheelshop evaluate \
  --input packages='[{"name":"cron-parser"},{"name":"cronstrue"},{"name":"croner"}]' \
  --input runtime=deno --json
# expected: cron-parser approved, top-ranked. Use the snippet.
```

### HTTP retry

```bash
curl -s 'https://registry.npmjs.org/-/v1/search?text=retry+backoff&size=15' | jq '.objects[].package | {name, description}'
# pick: p-retry, async-retry, exponential-backoff, retry
swamp model method run wheelshop evaluate \
  --input packages='[{"name":"p-retry"},{"name":"async-retry"},{"name":"exponential-backoff"},{"name":"retry"}]' \
  --input runtime=deno --json
```

### Niche / internal-only protocol

If two or three focused registry searches return nothing semantically relevant,
do not invent candidates. Tell the user: "No proven library found for
`<intent>`. Build native?"

## See also

- `swamp-extension-model` — authoring the extension once dependencies are picked
- README at `extensions/wheelshop/README.md` — full method/argument docs
