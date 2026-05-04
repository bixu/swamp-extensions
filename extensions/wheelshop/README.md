# @bixu/wheelshop

A [swamp](https://github.com/systeminit/swamp) extension model that helps
agents (and humans) discover proven npm/jsr TypeScript libraries instead of
reinventing logic in swamp-native TS.

Recommendations are filtered through trust gates — weekly downloads, license,
last publish date, maintenance score, OSV vulnerabilities, and type
availability. When all candidates fail the gates, wheelshop returns
`action: "ask_user"` so the calling agent knows to prompt a human rather than
silently fall back to a custom implementation.

## Installation

```bash
swamp extension pull @bixu/wheelshop
```

## Usage

Create a model definition:

```yaml
type: "@bixu/wheelshop"
name: wheelshop
globalArguments: {}
```

Then call methods:

```bash
# Find proven libraries for an intent
swamp model method run wheelshop search \
  --input intent="parse cron expressions" \
  --json

# Refine with extra keywords + runtime preference
swamp model method run wheelshop search \
  --input intent="exponential backoff" \
  --input keywords='["typescript","retry"]' \
  --input runtime=deno \
  --input limit=3 \
  --json

# Audit a specific package + version
swamp model method run wheelshop audit \
  --input package=cron-parser \
  --input version=5.5.0 \
  --json
```

## Methods

### `search`

| Argument   | Type                          | Default | Description                                                                |
| ---------- | ----------------------------- | ------- | -------------------------------------------------------------------------- |
| `intent`   | string                        | —       | Plain-English description of what you need a library for                   |
| `keywords` | string[]                      | `[]`    | Optional extra search terms                                                |
| `runtime`  | `"deno"` \| `"node"` \| `"both"` | `"both"` | Target runtime — jsr is preferred when `deno` or `both`                  |
| `limit`    | number (1-20)                 | `5`     | Max candidates to return after filtering                                   |
| `unsafe`   | boolean                       | `false` | Include candidates that fail trust gates (do not enable without approval) |

Returns a JSON object with `candidates`, `rejected`, and an `action`:

- `action: "ok"` — at least one candidate passed the gates.
- `action: "ask_user"` — no candidate passed; the agent should prompt a human
  rather than fall back to a custom implementation.

### `audit`

| Argument  | Type    | Default    | Description                                  |
| --------- | ------- | ---------- | -------------------------------------------- |
| `package` | string  | —          | npm package name (scoped or unscoped)        |
| `version` | string  | `"latest"` | Specific version to audit                    |
| `unsafe`  | boolean | `false`    | Mark `approved=true` even if blockers exist  |

Returns a JSON `auditReport` with `approved`, `blockers`, and the full set of
extracted facts.

## Trust Gates

Each gate is a `blocker` unless `unsafe=true`:

| Gate                  | Default                                                          |
| --------------------- | ---------------------------------------------------------------- |
| Weekly downloads      | < 1,000                                                          |
| License               | not in MIT, Apache-2.0, BSD-2/3-Clause, ISC, 0BSD, MPL-2.0, etc. |
| Last publish          | > 24 months ago                                                  |
| Maintenance score     | < 0.4 (npms.io)                                                  |
| Deprecated flag       | `true`                                                           |
| OSV vulnerabilities   | any HIGH/CRITICAL/UNKNOWN-severity advisory                      |
| Maintainer count      | 0 (orphaned)                                                     |
| Type availability     | no `types`, `typings`, or types in `exports` map                 |

JSR packages get a small ranking boost when `runtime` is `deno` or `both`
because JSR enforces TS-native publishing, provenance, and disallows install
scripts at the registry level.

## Caching

Registry responses are cached on disk for 24h at
`$HOME/.cache/swamp-wheelshop/` (override with `globalArguments.cacheDir` and
`globalArguments.cacheTtlHours`). Cache writes are best-effort; failures don't
propagate.

## Data Sources

- [npms.io](https://npms.io/) — search + composite quality scores
- [registry.npmjs.org](https://registry.npmjs.org/) — manifest, deprecated
  flag, types, license
- [api.npmjs.org](https://api.npmjs.org/) — weekly download counts
- [api.osv.dev](https://api.osv.dev/) — vulnerability advisories
- [jsr.io](https://jsr.io/) — JSR package search (best-effort)

## License

MIT
