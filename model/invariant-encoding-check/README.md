# @bixu/invariant-encoding-check

A [swamp](https://github.com/swamp-club/swamp) extension. It fails CI when
a changed `.ts` file in your model tree leaves a known invariant unencoded
in its zod schema. The rules enforce the mechanizable subset of "make
illegal states unrepresentable" so a bare `z.string()` on a digest,
a `z.any()`, or an `as any` cast cannot land quietly. Taste-shaped calls
(choice of branded type, whether a discriminated union fits) stay with
human review.

The extension also ships a small set of reusable zod schemas
(`Sha256DigestSchema`, `PlatformSchema`, `SshFingerprintSchema`). A
consumer can drop a correctly-shaped constraint into their own model.
No need to reinvent what the check looks for.

## Installation

```bash
swamp extension pull @bixu/invariant-encoding-check
```

## Configuration

Create a model definition:

```yaml
type: "@bixu/invariant-encoding-check"
name: invariant-check
globalArguments:
  root: extensions/models # default; the directory the checker scans
```

## Usage

Three scan modes on the `check` method — pick one:

```bash
# CI mode: scan every .ts file changed against the base ref
swamp model method run invariant-check check \
  --input baseRef=origin/main --json

# Explicit paths: scan exactly these files
swamp model method run invariant-check check \
  --input 'paths:json=["extensions/models/foo.ts"]' --json

# Full audit: scan every .ts under the root
swamp model method run invariant-check check --input all=true --json
```

Without `paths`, `baseRef`, or `all`, the check reads the
`GITHUB_BASE_REF` env var (the CI-native pattern). With no signal at all,
it writes an empty report and exits clean.

The method throws when it finds any violation, so a workflow step wired
to it fails the run. The findings also land in a `report` resource. A
downstream step can consume them via `data.latest`:

```yaml
- id: invariant-check
  method: check
  model: invariant-check
- id: post-findings
  when: data.latest("invariant-check", "report").findings.size() > 0
  method: post
  model: slack
  args:
    text: ${{ data.latest("invariant-check", "report").summary }}
```

## Rules

Each violation is a `Finding` with `{ file, line, rule, text }`.

| Rule                         | Fires on                                                                                                                                        |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `z-any`                      | Any occurrence of `z.any()`                                                                                                                     |
| `z-unknown`                  | `z.unknown()` outside a same-line `z.record(<keys>, z.unknown())`                                                                               |
| `as-any`                     | An `as any` cast                                                                                                                                |
| `as-unknown-as`              | An `as unknown as ...` double cast                                                                                                              |
| `bare-string-on-semantic-id` | A field named `digest`, `sha`, `sha256`, `fingerprint`, `sourceDigest`, `version`, `ref`, or `platform` typed as `z.string()` with no encoding  |
| `empty-exception-reason`     | An `// invariant-check:` marker with no reason after the colon                                                                                  |

An encoded chain adds `.regex(...)`, `.refine(...)`, `.brand(...)`,
or `.pipe(...)`.

## Escape hatch

An inline `// invariant-check: <reason>` comment on the same source line
silences that one line. An exception without a reason itself fails the
check, so the reason is part of the record.

```ts
const S = z.record(z.string(), z.unknown()); // ok on one line
const T = z.any(); // invariant-check: legacy shape we cannot type today
```

## Known matcher gaps

Each gap is a small documented follow-up. If you hit one, patch the check —
do not silence the finding.

- Array forms like `platforms: z.array(z.string())` slip through. The
  semantic-id rule looks for `<id>: z.string()` at the field position, not
  inside an `array()` wrapper.
- Line-bound matching: a chain that `deno fmt` wraps across two lines
  (`field: z\n  .string()`) evades the semantic-id rule. `deno fmt --check`
  in CI keeps this rare.
- The `z.any` / `z.unknown` / `as any` / `as unknown as` checks read the
  raw line. Those tokens inside a string literal (a
  `.describe("do not use as any")` doc, say) would false-flag. The check
  strips trailing `// ...` comments before matching (with a
  whitespace-before-`//` guard so URLs inside strings survive), so only
  string-literal contents remain a concern. Use the escape hatch.
- Compound camel-case names in fields slip through today. The semantic-id
  list matches whole tokens, so `manifestDigest:`, `targetDigest:`,
  `targetRef:` stay invisible. Broaden the alternation when someone hits
  this.
- Non-empty parens slip through: the rule matches `z.string()`, not
  `z.string({ description: "..." })`.
- `.brand<Generic>()` slips past the encoded-chain regex, which wants
  `.brand(` as a literal. Use `.brand("Name")` or a `.regex(...)` /
  `.refine(...)` chain when a branded field needs to satisfy the check.

## Shared schemas

The extension bundle ships `schemas.ts` as an `additionalFiles` entry.
The three shapes match what the check enforces. You can import them into
your own model.

- `Sha256DigestSchema` — `sha256:<64 lowercase hex>`, anchored. OCI
  content digest.
- `Sha256HexSchema` — 64 lowercase hex, NO `sha256:` prefix. Bare SHA-256
  as `sha256Hex(...)` returns for the OCI patch fingerprint.
- `GitCommitShaSchema` — 40 lowercase hex. Full git commit sha (never
  abbreviated).
- `PgpFingerprintSchema` — 40 or 64 uppercase hex. OpenPGP v4 or v5
  fingerprint.
- `PlatformSchema` — OCI platform: `arch`, `os/arch`, or `os/arch/variant`.
- `SshFingerprintSchema` — `ssh-keygen -lf` output: `SHA256:<base64>` or
  `MD5:<hex-with-colons>`.

Swamp does not expose a runtime path for one extension to `import`
TypeScript from another. Consumers pick one of:

1. Vendor the file into the consuming extension's `_lib/` and keep it in
   sync by hand (small file, changes rarely).
2. Fetch it in CI from this repo:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/bixu/swamp-extensions/main/model/invariant-encoding-check/schemas.ts \
     -o _lib/invariant_schemas.ts
   ```
3. Reimplement the three regexes in your own model. The regex source is
   the canonical form. If you rewrite it, run the schema's test suite on
   both copies to keep them in agreement.

## License

MIT — see [LICENSE.txt](LICENSE.txt).
