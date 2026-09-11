/**
 * @module
 * Fail CI when a swamp extension model file leaves a known invariant
 * unencoded in its zod schema. Enforces the mechanizable subset of "make
 * illegal states unrepresentable" — the taste-shaped parts (choice of
 * branded type, whether a discriminated union fits) stay with human review.
 *
 * Three scan modes:
 *   - **paths** — scan exactly the listed files.
 *   - **baseRef** (or `GITHUB_BASE_REF`) — scan every `.ts` under `root`
 *     changed against that git ref. Greets a repo that has pre-existing
 *     violations without blocking every unrelated PR.
 *   - **all** — scan every `.ts` under `root`. Use for one-time audits or
 *     to reproduce a failure locally.
 *
 * Rules (line-bound):
 *   - No `z.any()` anywhere.
 *   - No `z.unknown()`, except inside a same-line `z.record(<keys>,
 *     z.unknown())` — the accepted opaque-payload pattern.
 *   - No `as any` casts.
 *   - No `as unknown as ...` double casts.
 *   - No bare `z.string()` on a field whose name is a semantic identifier
 *     (digest, sha, sha256, fingerprint, sourceDigest, version, ref,
 *     platform) unless the chain adds `.regex(`, `.refine(`, `.brand(`,
 *     or `.pipe(`.
 *
 * Known matcher gaps, each wanting its own follow-up:
 *   - Array forms like `platforms: z.array(z.string())` slip through.
 *   - Line-bound matching: a chain `deno fmt` wraps as `field: z\n`
 *     `  .string()` splits across lines and evades detection. Practical
 *     exposure is small because `deno fmt --check` runs on the scanned
 *     directory, but the gap is real.
 *   - The `z.any()` / `z.unknown()` / `as any` / `as unknown as` checks
 *     run against the raw line, so the tokens inside a string literal
 *     (a `.describe("do not use as any")` doc, say) would false-flag.
 *     Trailing `// ...` comments are stripped before matching (with a
 *     whitespace-before-`//` guard so URLs inside strings survive), so
 *     only string-literal contents remain a concern; use the
 *     `// invariant-check: <reason>` hatch on the rare false positive.
 *   - Compound camelCase field names slip through: SEMANTIC_IDS matches
 *     whole tokens, so `manifestDigest:` / `targetDigest:` / `targetRef:`
 *     are invisible to the semantic-id rule today. Broaden the alternation
 *     with a per-suffix pattern when someone hits this.
 *   - Non-empty parens slip through: the rule matches `z.string()` only,
 *     not `z.string({ description: "..." })`. Relaxing to `z\.string\s*\(`
 *     picks the arg form up too but pulls in downstream chain-parse
 *     complexity; defer until a legitimate use of the arg form exists.
 *   - `.brand<Generic>()` slips past the encoded-chain regex, which wants
 *     `.brand(` as a literal. The runtime call is still `.brand(...)`, so
 *     the intent is encoded — the regex just cannot see it. Use
 *     `.brand("Name")` or a `.regex(...)`/`.refine(...)` chain when a
 *     branded platform/digest/version field needs to satisfy this check.
 *
 * Escape hatch: an inline `// invariant-check: <reason>` comment on the
 * same source line silences that one line. An exception without a reason
 * fails the check.
 *
 * The `check` method throws when any finding is present, so a swamp
 * workflow step wired to this method fails the run — the same shape as
 * the `require-uat-methods` gate.
 */
// deno-lint-ignore-file no-import-prefix
import { z } from "npm:zod@4";
import { expandGlob } from "jsr:@std/fs@1/expand-glob";

/** One rule violation on one line of one file. */
export const FindingSchema = z.object({
  file: z.string(),
  line: z.number().int().positive(),
  rule: z.enum([
    "empty-exception-reason",
    "bare-string-on-semantic-id",
    "z-any",
    "z-unknown",
    "as-any",
    "as-unknown-as",
  ]),
  text: z.string(),
});
export type Finding = z.infer<typeof FindingSchema>;

/** Result written to the `report` resource on every `check` invocation. */
export const ReportSchema = z.object({
  findings: z.array(FindingSchema),
  scannedFiles: z.array(z.string()),
  scanMode: z.enum(["paths", "baseRef", "all", "none"]),
  generatedAt: z.string(),
  summary: z.string(),
});

export const GlobalArgsSchema = z.object({
  root: z.string().default("extensions/models").describe(
    "Directory to scan, relative to the working directory. Only matters for baseRef and all modes.",
  ),
});

const SEMANTIC_IDS = [
  "sourceDigest",
  "digest",
  "sha256",
  "sha",
  "fingerprint",
  "version",
  "ref",
  "platform",
];
// Alternation order matters: longer names first so `sourceDigest:` is
// matched as `sourceDigest`, not `digest` from mid-word.
const semanticIdRe = new RegExp(
  `\\b(${SEMANTIC_IDS.join("|")})\\s*:\\s*z\\.string\\s*\\(\\s*\\)([^,\\n]*)`,
);
const encodedChain = /\.(regex|refine|brand|pipe)\s*\(/;
const bareAnyRe = /\bz\.any\s*\(\s*\)/;
const bareUnknownRe = /\bz\.unknown\s*\(\s*\)/;
// A `z.unknown()` inside `z.record(<keys>, z.unknown())` is the accepted
// pattern for "opaque bag of upstream API payload we do not own the schema
// of". The alternative is a heavier schema that lies about what the vendor
// actually returns. Only that specific containing shape is allowed — and
// only when the whole `.record(..., z.unknown())` sits on one line, since
// the matching loop is line-bound.
const recordOfUnknownRe = /\.record\s*\([\s\S]*?,\s*z\.unknown\s*\(\s*\)/;
const asAnyRe = /\bas\s+any\b/;
const asUnknownAsRe = /\bas\s+unknown\s+as\b/;
const escapeHatchRe = /\/\/\s*invariant-check\s*:\s*\S/;
const escapeHatchEmptyRe = /\/\/\s*invariant-check\s*:\s*(?:$|\s*$)/;
const lineCommentRe = /^\s*(?:\/\/|\*)/;

/**
 * Scan the source of a single file and collect findings. Pure — no I/O,
 * so tests can throw source strings at it directly.
 */
export function scanSource(file: string, source: string): Finding[] {
  const findings: Finding[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (lineCommentRe.test(raw)) continue;
    // Strip a trailing `// ...` comment before rule matching. The
    // whitespace-before-`//` guard keeps URLs inside string literals
    // (`https://...`) untouched, since the `s` preceding the `//` is not
    // whitespace.
    const line = raw.replace(/\s\/\/[^\n]*$/, "");

    // Reject an exception marker with no reason before honoring one with.
    if (escapeHatchEmptyRe.test(raw)) {
      findings.push({
        file,
        line: i + 1,
        rule: "empty-exception-reason",
        text: raw.trim(),
      });
      continue;
    }
    if (escapeHatchRe.test(raw)) continue;

    const idMatch = line.match(semanticIdRe);
    // Group 2 (`[^,\n]*`) is a `*`-quantified capture — always populated,
    // never undefined — so no `?? ""` fallback needed.
    if (idMatch && !encodedChain.test(idMatch[2])) {
      findings.push({
        file,
        line: i + 1,
        rule: "bare-string-on-semantic-id",
        text: raw.trim(),
      });
    }
    if (bareAnyRe.test(line)) {
      findings.push({ file, line: i + 1, rule: "z-any", text: raw.trim() });
    }
    if (bareUnknownRe.test(line) && !recordOfUnknownRe.test(line)) {
      findings.push({
        file,
        line: i + 1,
        rule: "z-unknown",
        text: raw.trim(),
      });
    }
    if (asAnyRe.test(line)) {
      findings.push({ file, line: i + 1, rule: "as-any", text: raw.trim() });
    }
    if (asUnknownAsRe.test(line)) {
      findings.push({
        file,
        line: i + 1,
        rule: "as-unknown-as",
        text: raw.trim(),
      });
    }
  }
  return findings;
}

/**
 * Run `git diff --name-only <ref>...HEAD -- <root>` and return the changed
 * `.ts` files (excluding `_test.ts`). A `git diff` failure (missing
 * origin/<base>, renamed base branch, bad fetch) also yields an empty
 * stdout — indistinguishable from "nothing changed" unless we look at the
 * exit code. Fail loud instead of turning the whole gate into a silent
 * no-op.
 */
export function changedTsFiles(baseRef: string, root: string): string[] {
  const diffRef = baseRef.includes("..") ? baseRef : `${baseRef}...HEAD`;
  const out = new Deno.Command("git", {
    args: ["diff", "--name-only", diffRef, "--", root],
    stdout: "piped",
    stderr: "piped",
  }).outputSync();
  if (!out.success) {
    const stderr = new TextDecoder().decode(out.stderr).trim();
    throw new Error(`git diff ${diffRef} exited non-zero: ${stderr}`);
  }
  return new TextDecoder()
    .decode(out.stdout)
    .split("\n")
    .filter((f) => f.endsWith(".ts") && !f.endsWith("_test.ts") && f !== "");
}

/** Walk `<root>/**\/*.ts` (excluding `_test.ts`) and return every match. */
export async function allTsFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of expandGlob(`${root}/**/*.ts`)) {
    if (entry.isFile && !entry.path.endsWith("_test.ts")) {
      files.push(entry.path.replace(`${Deno.cwd()}/`, ""));
    }
  }
  return files;
}

/** Format the collected findings the way the source Deno script does. */
export function formatFindingsMessage(findings: Finding[]): string {
  const header = `${findings.length} unencoded invariant(s) found`;
  const body = findings
    .map((f) => `  ${f.file}:${f.line} [${f.rule}] ${f.text}`)
    .join("\n");
  return `${header}\n${body}\n\nFix: encode the invariant into the zod schema — .regex(...), .refine(...), .brand(...), or .pipe(...) — or add \`// invariant-check: <written reason>\` on the same line.`;
}

const CheckArgsSchema = z.object({
  paths: z.array(z.string()).optional().describe(
    "Explicit file paths to scan. Overrides baseRef and all.",
  ),
  baseRef: z.string().optional().describe(
    "Git base ref to diff against (e.g. 'origin/main'). Falls back to GITHUB_BASE_REF env var when unset.",
  ),
  all: z.boolean().default(false).describe(
    "Scan every .ts file under root. Overridden by paths.",
  ),
  root: z.string().optional().describe(
    "Override the globalArgs root for this call.",
  ),
});

/**
 * Resolve the list of files to scan from the three-mode argument shape.
 * Separate from `execute` so tests can drive it directly.
 */
export async function resolveScanFiles(
  args: z.infer<typeof CheckArgsSchema>,
  root: string,
): Promise<{ files: string[]; mode: "paths" | "baseRef" | "all" | "none" }> {
  if (args.paths && args.paths.length > 0) {
    return { files: args.paths, mode: "paths" };
  }
  if (args.all) {
    return { files: await allTsFiles(root), mode: "all" };
  }
  const baseRef = args.baseRef ?? Deno.env.get("GITHUB_BASE_REF");
  if (baseRef) {
    const ref = baseRef.includes("/") || baseRef.includes("..")
      ? baseRef
      : `origin/${baseRef}`;
    return { files: changedTsFiles(ref, root), mode: "baseRef" };
  }
  return { files: [], mode: "none" };
}

/**
 * Swamp extension model for the invariant-encoding check.
 *
 * Resources produced:
 * - `report` — the findings plus scan metadata (files scanned, mode).
 *   Callers can read it via `data.latest("<name>", "report")`.
 */
export const model = {
  type: "@bixu/invariant-encoding-check",
  version: "2026.09.10.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    report: {
      description:
        "Findings from the invariant-encoding scan, plus scan metadata",
      schema: ReportSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  methods: {
    check: {
      description:
        "Scan model files and fail (throw) when any known invariant is left unencoded in its zod schema. Modes: paths (explicit list) > all > baseRef (git diff, GITHUB_BASE_REF env fallback).",
      arguments: CheckArgsSchema,
      // deno-lint-ignore no-explicit-any
      execute: async (args: any, context: any) => {
        const parsedArgs = CheckArgsSchema.parse(args);
        const root = parsedArgs.root ?? context.globalArgs.root;
        const { files, mode } = await resolveScanFiles(parsedArgs, root);

        if (files.length === 0) {
          context.logger.info(
            "No model files in scope — skipping invariant-encoding check",
          );
          const handle = await context.writeResource("report", "latest", {
            findings: [],
            scannedFiles: [],
            scanMode: mode,
            generatedAt: new Date().toISOString(),
            summary: "No model files in scope",
          });
          return { dataHandles: [handle] };
        }

        const findings: Finding[] = [];
        for (const file of files) {
          let source: string;
          try {
            source = await Deno.readTextFile(file);
          } catch (err) {
            // A deleted-in-the-diff file is the only skip-worthy read
            // failure; permission errors, symlink loops, etc. should
            // surface, not turn the gate into a silent no-op — same
            // reasoning as the git-diff branch.
            if (err instanceof Deno.errors.NotFound) continue;
            throw new Error(
              `cannot read ${file}: ${(err as Error).message}`,
            );
          }
          findings.push(...scanSource(file, source));
        }

        const summary = findings.length === 0
          ? `OK: ${files.length} model file(s) pass invariant-encoding`
          : formatFindingsMessage(findings);

        const handle = await context.writeResource("report", "latest", {
          findings,
          scannedFiles: files,
          scanMode: mode,
          generatedAt: new Date().toISOString(),
          summary,
        });

        if (findings.length > 0) {
          context.logger.error(summary);
          throw new Error(summary);
        }
        context.logger.info(summary);
        return { dataHandles: [handle] };
      },
    },
  },
};
