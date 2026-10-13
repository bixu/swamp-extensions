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

### `survey`

Ranks the community extensions for a domain through the swamp CLI
(`swamp extension search` and `swamp extension info`):

```bash
swamp model method run wheelshop survey --input query=tailscale --json
```

Ordering: names containing every query word first, then official `@swamp/*`
extensions, then health (yanked, deprecated, superseded, not updated in 24
months, no repository), then quality score, pulls and recency. The top relevant,
healthy extension with models is the suggested `base`. Each candidate reports:

- `reusable`: its license allows copying code (an AGPL base can still be a
  dependency). Licenses missing from the registry are read from a pulled copy at
  the latest version.
- `overlapWithBase`: the share of its method names the base also has.
  `likelyRedundant` at 100%.

### `smoosh`

Builds a derived extension from files of pulled community extensions:

```bash
swamp model method run wheelshop smoosh \
  --input outDir=model/tailscale-community \
  --input name=@bixu/tailscale-community \
  --input description="Community add-ons for @swamp/tailscale" \
  --input base=@swamp/tailscale \
  --input sources='[{"extension":"@sntxrr/tailscale-acl-drift","version":"2026.07.24.2","repository":"https://github.com/sntxrr/swamp-tailscale","files":[{"from":"models/tailscale_acl_drift.ts","to":"policy_drift.ts"},{"from":"models/tailscale_acl_propose.ts","to":"policy_propose.ts"}],"retarget":{"@john/tailscale-acl":"@swamp/tailscale/policy-file"}}]' \
  --json
```

Pull each source at the given version first. `smoosh`:

- copies each file from the pulled copy and adds a `Derived from` header
- swaps model types per `retarget` and rewires relative imports between copied
  files
- appends each source's license to `LICENSE.txt`
- merges `manifest.yaml`, with `base` as a dependency
- runs the `attribute` checks

It never overwrites a derived file that has been edited since it wrote it; the
file is reported under `kept`. Blockers left for an agent or human:

| Blocker                      | Meaning                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------- |
| `needs-adaptation:<file>`    | Retargeted code reads the base model's stored data; check the new type's schema |
| `unmapped-import:<file>`     | Imports a source file that was not carried over                                 |
| `own-license-missing`        | Put your own license at the top of `LICENSE.txt`                                |
| `readme-missing`             | Write `README.md`                                                               |
| `not-pulled:<ext>@<version>` | Pull the source at that exact version                                           |

Re-run `smoosh` after fixing them; edited files stop being flagged.

### `attribute`

After an agent combines parts of community swamp extensions into a new one,
`attribute` records where the code came from and checks the new extension
credits it.

```bash
swamp model method run wheelshop attribute \
  --input manifestPath=model/my-ext/manifest.yaml \
  --input sources='[{"extension":"@john/tailscale","version":"2026.03.02.1","repository":"https://github.com/john/tailscale","files":[{"from":"tailscale/device.ts","to":"device_client.ts"}]}]' \
  --json
```

Get `repository` for each source from `swamp extension info <name> --json`.
Leave `license` out and `attribute` reads it from the source's LICENSE file.
That needs the same version pulled into the repo
(`swamp extension pull <name>`), because the registry usually has no license on
record.

It writes `prior-art.yaml` beside the manifest:

```yaml
derivedFrom:
  - extension: "@john/tailscale"
    version: 2026.03.02.1
    repository: https://github.com/john/tailscale
    license: MIT
    files:
      - from: tailscale/device.ts
        to: device_client.ts
```

Then it returns `action: "fix"` with blockers until:

- `prior-art.yaml` is listed in the manifest's `additionalFiles`
- each derived file contains `Derived from <extension>@<version>`
- `LICENSE.txt` names each source extension
- each source license is on the allowlist (unknown licenses block)

The swamp manifest has no provenance field yet, so `prior-art.yaml` ships as an
additional file.

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
