# @bixu/wheelshop

A [swamp](https://github.com/systeminit/swamp) extension model that scores
npm/jsr TypeScript packages against trust gates so swamp extension authors (and
the agents working alongside them) can verify a candidate package is safe to
depend on before adding the import.

Trust gates: weekly downloads, license, last publish date, maintenance score,
OSV vulnerabilities, type availability. When every candidate fails the gates,
wheelshop returns `action: "ask_user"` so the calling agent knows to prompt a
human rather than silently fall back to a custom implementation.

**Discovery is not wheelshop's job.** Searching the registry and picking
semantically relevant candidates is the agent's responsibility. Wheelshop audits
whatever list it's given. See the bundled `swamp-wheelshop` skill for the
agent-side flow.

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

Then call the `evaluate` method with a list of candidates:

```bash
swamp model method run wheelshop evaluate \
  --input packages='[{"name":"p-retry"},{"name":"async-retry"},{"name":"got"}]' \
  --input runtime=deno \
  --json
```

Each entry in `packages` is `{name, version?, registry?}`:

- `name` — npm or JSR package name (scoped or unscoped for npm; JSR is always
  scoped `@scope/name`)
- `version` — optional; defaults to the latest published version
- `registry` — `"npm"` (default) or `"jsr"`

## Method

### `evaluate`

| Argument   | Type                                 | Default  | Description                                                                       |
| ---------- | ------------------------------------ | -------- | --------------------------------------------------------------------------------- |
| `packages` | `Array<{name, version?, registry?}>` | —        | 1-20 candidate packages to audit                                                  |
| `runtime`  | `"deno"` \| `"node"` \| `"both"`     | `"both"` | Target runtime — affects scoring; JSR candidates boosted for `deno` or `both`     |
| `unsafe`   | boolean                              | `false`  | Mark every candidate approved even when blockers exist (require explicit consent) |

Returns:

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
      "blockers": [],
      "...": "remaining facts"
    }
  ],
  "notFound": [],
  "thresholds": { "...": "..." }
}
```

- `action: "ok"` — at least one candidate passed the gates (or `unsafe=true`).
- `action: "ask_user"` — every candidate failed; the agent should prompt the
  user rather than fall back to a custom implementation.

## Trust Gates

Each gate is a `blocker` unless `unsafe=true`:

| Gate                | Default                                                          |
| ------------------- | ---------------------------------------------------------------- |
| Weekly downloads    | < 1,000                                                          |
| License             | not in MIT, Apache-2.0, BSD-2/3-Clause, ISC, 0BSD, MPL-2.0, etc. |
| Last publish        | > 24 months ago                                                  |
| Maintenance score   | < 0.4 (npm search composite)                                     |
| Deprecated flag     | `true`                                                           |
| OSV vulnerabilities | any HIGH/CRITICAL/UNKNOWN-severity advisory                      |
| Maintainer count    | 0 (orphaned)                                                     |
| Type availability   | no `types`, `typings`, or types in `exports` map                 |

JSR packages bypass the license, downloads, and types gates because JSR enforces
SPDX licensing, TS-native publishing, and provenance at the registry level. JSR
candidates get a small ranking boost when `runtime` is `deno` or `both`.

## Caching

Registry responses are cached on disk for 24h at `$HOME/.cache/swamp-wheelshop/`
(override with `globalArguments.cacheDir` and `globalArguments.cacheTtlHours`).
Cache writes are best-effort; failures don't propagate.

## Data Sources

- [registry.npmjs.org](https://registry.npmjs.org/) — manifest, deprecated flag,
  types, license, publish dates, maintainers
- [api.npmjs.org](https://api.npmjs.org/) — weekly download counts
- [api.osv.dev](https://api.osv.dev/) — vulnerability advisories (npm + JSR
  ecosystems)
- [jsr.io/api](https://jsr.io/api) — JSR package and version metadata

## License

MIT
