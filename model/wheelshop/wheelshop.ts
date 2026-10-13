/**
 * @module
 * Wheelshop — trust-gate auditor for npm/jsr packages used inside swamp
 * extension models.
 *
 * Agents handle discovery and semantic relevance (search npm/jsr directly,
 * read descriptions, pick candidates). Wheelshop scores those candidates
 * against published trust gates (license, downloads, recency, maintenance,
 * OSV vulnerabilities, type availability) and returns approval verdicts.
 *
 * Methods:
 * - **evaluate** — given a list of `{name, version?, registry?}` candidates,
 *   audit each against the trust gates and return ranked verdicts.
 *
 * - **survey** — rank the community swamp extensions for a domain (via the
 *   swamp CLI), suggest a base, and show which are reusable or redundant.
 * - **smoosh** — build a derived extension from files of pulled community
 *   extensions: copy, header, retarget, rewire imports, license notices,
 *   manifest, then the attribute checks.
 * - **attribute** — after an agent combines parts of community swamp extensions
 *   into a new one, write `prior-art.yaml` beside its manifest and check that
 *   every source is credited (file headers, LICENSE notice, shipped file).
 *
 * When every candidate fails the gates, the model returns `action: "ask_user"`
 * so the calling agent knows to prompt a human rather than silently fall back
 * to a custom implementation.
 */
import { z } from "npm:zod@4";
import {
  parse as parseYaml,
  stringify as stringifyYaml,
} from "jsr:@std/yaml@1.2.0";
import { buildSurvey, type SwampExtensionInfo } from "./wheelshop_survey.ts";
import {
  calverToday,
  canonicalJson,
  isEntryPoint,
  licenseNotice,
  mergeManifest,
  retarget,
  rewireImports,
  smooshHeader,
} from "./wheelshop_smoosh.ts";
import {
  buildRationale,
  buildSnippet,
  cachedJsonFetch,
  checkAttribution,
  DEFAULT_THRESHOLDS,
  detectSpdxLicense,
  detectTypes,
  evaluateGates,
  fnv1a32,
  maintainerCount,
  normaliseVulns,
  type PkgFacts,
  PRIOR_ART_FILE,
  type PriorArtSource,
  rankScore,
  type TypesAvailability,
  type Vuln,
} from "./wheelshop_helpers.ts";

const HOME = Deno.env.get("HOME") ?? "/tmp";
const CACHE_DIR = `${HOME}/.cache/swamp-wheelshop`;

const NPM_REGISTRY_URL = "https://registry.npmjs.org";
const NPM_DOWNLOADS_URL = "https://api.npmjs.org/downloads/point/last-week";
const OSV_QUERY_URL = "https://api.osv.dev/v1/query";
const JSR_API_URL = "https://jsr.io/api";

const GlobalArgsSchema = z.object({
  cacheDir: z.string().default(CACHE_DIR).describe(
    "Directory for the 24h fetch cache",
  ),
  cacheTtlHours: z.number().default(24).describe(
    "How long cached registry responses stay fresh, in hours",
  ),
});

// npm package names: scoped (@scope/name) or unscoped (name).
// JSR package names are always scoped: @scope/name.
const NPM_PKG_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
// npm versions: semver (starts with digit) or dist-tag (starts with letter).
const NPM_VER_RE = /^[a-zA-Z0-9][a-zA-Z0-9._+\-]*$/;

const PackageRefSchema = z.object({
  name: z.string()
    .regex(NPM_PKG_RE, "invalid package name")
    .describe("Package name (e.g. 'p-retry', '@aws-sdk/client-s3')"),
  version: z.string()
    .regex(NPM_VER_RE, "invalid version or dist-tag")
    .optional()
    .describe("Specific version (default: latest from the registry)"),
  registry: z.enum(["npm", "jsr"]).default("npm").describe(
    "Source registry — defaults to npm",
  ),
});

const EvaluateArgs = z.object({
  packages: z.array(PackageRefSchema).min(1).max(20).describe(
    "Candidate packages to evaluate. Pick these yourself by searching npm/jsr and reading descriptions for semantic fit before calling.",
  ),
  runtime: z.enum(["deno", "node", "both"]).default("both").describe(
    "Target runtime — affects scoring; JSR candidates get a small boost when 'deno' or 'both'",
  ),
  unsafe: z.boolean().default(false).describe(
    "Mark every candidate approved even when blockers are present (DO NOT enable without explicit user approval)",
  ),
});

const PriorArtSourceSchema = z.object({
  extension: z.string()
    .regex(/^@[a-z0-9_-]+\/[a-z0-9_/-]+$/, "invalid extension name")
    .describe("Source swamp extension (e.g. '@john/tailscale')"),
  version: z.string()
    .regex(/^\d{4}\.\d{2}\.\d{2}\.\d+$/, "invalid CalVer version")
    .describe("Exact source version the code was taken from"),
  repository: z.string().url().nullable().default(null).describe(
    "Source repository URL, from `swamp extension info <name> --json`",
  ),
  license: z.string().nullable().default(null).describe(
    "Source SPDX license. Omit to read it from the source's LICENSE file, which needs that exact version pulled into this repo",
  ),
  files: z.array(z.object({
    from: z.string().min(1).describe("File path inside the source extension"),
    to: z.string().min(1).describe(
      "Derived file path, relative to the new manifest",
    ),
  })).min(1),
});

const AttributeArgs = z.object({
  manifestPath: z.string().describe(
    "Path to the derived extension's manifest.yaml (paths.base: manifest)",
  ),
  sources: z.array(PriorArtSourceSchema).min(1).describe(
    "Every community extension that code was taken from",
  ),
});

const AttributionSchema = z.object({
  action: z.enum(["ok", "fix"]),
  extension: z.string(),
  priorArtPath: z.string(),
  sources: z.array(PriorArtSourceSchema),
  blockers: z.array(z.string()),
  message: z.string(),
});

const SurveyArgs = z.object({
  query: z.string().regex(/^[^-]/, "must not start with '-'").describe(
    "Domain to survey, as for `swamp extension search` (e.g. 'tailscale')",
  ),
  limit: z.number().int().min(1).max(50).default(20).describe(
    "Maximum search results to inspect",
  ),
});

const SurveySchema = z.object({
  query: z.string(),
  base: z.string().nullable(),
  candidates: z.array(z.object({
    name: z.string(),
    version: z.string(),
    official: z.boolean(),
    relevant: z.boolean(),
    repository: z.string().nullable(),
    license: z.string().nullable(),
    reusable: z.boolean(),
    blockers: z.array(z.string()),
    score: z.number().nullable(),
    pullCount: z.number().nullable(),
    updatedAt: z.string().nullable(),
    methods: z.record(z.string(), z.array(z.string())),
    overlapWithBase: z.number().nullable(),
    likelyRedundant: z.boolean(),
  })),
  message: z.string(),
});

const SmooshSourceSchema = PriorArtSourceSchema.extend({
  files: z.array(z.object({
    from: z.string()
      .regex(/^(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/, "invalid path")
      .describe(
        "Path inside the pulled source, e.g. 'models/tailscale_acl_drift.ts'",
      ),
    to: z.string()
      .regex(/^[A-Za-z0-9._-]+$/, "must be a flat file name")
      .describe("File name in the derived extension (flat, beside manifest)"),
  })).min(1),
  retarget: z.record(z.string(), z.string()).default({}).describe(
    "Model types to swap in copied code, old → new (e.g. {'@john/tailscale-acl': '@swamp/tailscale/policy-file'})",
  ),
});

const SmooshArgs = z.object({
  outDir: z.string().describe(
    "Directory of the derived extension, e.g. model/tailscale-community",
  ),
  name: z.string()
    .regex(/^@[a-z0-9_-]+\/[a-z0-9_/-]+$/, "invalid extension name")
    .describe("Derived extension name, e.g. '@bixu/tailscale-community'"),
  description: z.string().min(1).describe("Manifest description"),
  base: z.string()
    .regex(/^@[a-z0-9_-]+\/[a-z0-9_/-]+$/, "invalid extension name")
    .describe("Extension the derived one builds on, added to dependencies"),
  sources: z.array(SmooshSourceSchema).min(1).describe(
    "Pulled community extensions to take files from",
  ),
});

const SmooshSchema = z.object({
  action: z.enum(["ok", "fix"]),
  extension: z.string(),
  outDir: z.string(),
  written: z.array(z.string()),
  kept: z.array(z.string()),
  blockers: z.array(z.string()),
  message: z.string(),
});

const EvaluationSchema = z.object({
  package: z.string(),
  version: z.string(),
  registry: z.string(),
  description: z.string().nullable(),
  license: z.string().nullable(),
  weeklyDownloads: z.number().nullable(),
  lastPublish: z.string().nullable(),
  qualityScore: z.number().nullable(),
  types: z.string(),
  approved: z.boolean(),
  score: z.number(),
  rationale: z.string(),
  snippet: z.string().nullable(),
  blockers: z.array(z.string()),
  repository: z.string().nullable(),
}).passthrough();

const SummarySchema = z.object({
  action: z.enum(["ok", "ask_user"]),
  packageCount: z.number(),
  approvedCount: z.number(),
  message: z.string(),
});

interface NpmManifest {
  types?: string;
  typings?: string;
  exports?: unknown;
  deprecated?: string | boolean;
  repository?: { url?: string } | string;
  license?: string | { type?: string };
  maintainers?: unknown[];
  description?: string;
  version: string;
}

async function npmManifest(
  pkg: string,
  version: string | undefined,
  fetchOpts: { cacheDir: string; ttlMs: number },
): Promise<NpmManifest | null> {
  const tag = version ?? "latest";
  try {
    const { body } = await cachedJsonFetch(
      `${NPM_REGISTRY_URL}/${pkg}/${tag}`,
      fetchOpts,
    );
    return body as NpmManifest;
  } catch {
    return null;
  }
}

async function npmDownloads(
  pkg: string,
  fetchOpts: { cacheDir: string; ttlMs: number },
): Promise<number | null> {
  try {
    const { body } = await cachedJsonFetch(
      `${NPM_DOWNLOADS_URL}/${pkg}`,
      fetchOpts,
    );
    const downloads = (body as Record<string, unknown>).downloads;
    return typeof downloads === "number" ? downloads : null;
  } catch {
    return null;
  }
}

/**
 * Fetch the published date for a specific version from the npm registry's
 * full package doc. The abbreviated `vnd.npm.install-v1+json` view strips the
 * `time` map, so we have to take the larger payload (cached for 24h).
 */
async function npmPublishDate(
  pkg: string,
  version: string,
  fetchOpts: { cacheDir: string; ttlMs: number },
): Promise<string | null> {
  try {
    const { body } = await cachedJsonFetch(
      `${NPM_REGISTRY_URL}/${pkg}`,
      fetchOpts,
    );
    const time = (body as { time?: Record<string, string> }).time;
    if (!time) return null;
    return time[version] ?? time.modified ?? null;
  } catch {
    return null;
  }
}

async function osvVulns(
  pkg: string,
  version: string,
  ecosystem: "npm" | "JSR",
  fetchOpts: { cacheDir: string; ttlMs: number },
): Promise<Vuln[]> {
  try {
    const { body } = await cachedJsonFetch(OSV_QUERY_URL, {
      ...fetchOpts,
      init: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          package: { name: pkg, ecosystem },
          version,
        }),
      },
    });
    return normaliseVulns(body);
  } catch {
    return [];
  }
}

/** Repository URL from an npm manifest's string or `{ url }` form. */
export function extractRepo(manifest: NpmManifest | null): string | null {
  if (!manifest) return null;
  if (typeof manifest.repository === "string") return manifest.repository;
  if (manifest.repository && typeof manifest.repository === "object") {
    return manifest.repository.url ?? null;
  }
  return null;
}

/** License from an npm manifest's string or legacy `{ type }` form. */
export function extractLicense(manifest: NpmManifest | null): string | null {
  if (!manifest) return null;
  if (typeof manifest.license === "string") return manifest.license;
  if (manifest.license && typeof manifest.license === "object") {
    return manifest.license.type ?? null;
  }
  return null;
}

async function enrichNpmCandidate(
  name: string,
  requestedVersion: string | undefined,
  fetchOpts: { cacheDir: string; ttlMs: number },
): Promise<PkgFacts | { notFound: true; package: string }> {
  const manifest = await npmManifest(name, requestedVersion, fetchOpts);
  if (!manifest) {
    return { notFound: true, package: name };
  }
  // If the caller requested a concrete semver version, verify the registry
  // returned exactly that version. Dist-tags like "latest" are allowed to
  // resolve freely.
  if (
    requestedVersion && /^\d/.test(requestedVersion) &&
    manifest.version !== requestedVersion
  ) {
    return { notFound: true, package: `${name}@${requestedVersion}` };
  }
  const version = manifest.version ?? requestedVersion ?? "latest";

  const [downloads, vulns, lastPublish] = await Promise.all([
    npmDownloads(name, fetchOpts),
    osvVulns(name, version, "npm", fetchOpts),
    npmPublishDate(name, version, fetchOpts),
  ]);

  const types: TypesAvailability = detectTypes(manifest);

  return {
    package: name,
    version,
    registry: "npm",
    description: manifest.description ?? null,
    license: extractLicense(manifest),
    weeklyDownloads: downloads,
    lastPublish,
    qualityScore: null,
    popularityScore: null,
    maintenanceScore: null,
    deprecated: !!manifest.deprecated,
    maintainerCount: maintainerCount(manifest.maintainers),
    types,
    vulns,
    repository: extractRepo(manifest),
  };
}

interface JsrPackageDoc {
  scope: string;
  name: string;
  description?: string;
  latestVersion?: string;
  githubRepository?: { owner: string; name: string };
}

interface JsrVersionDoc {
  version: string;
  yanked?: boolean;
  createdAt?: string;
}

async function jsrPackageDoc(
  scope: string,
  name: string,
  fetchOpts: { cacheDir: string; ttlMs: number },
): Promise<JsrPackageDoc | null> {
  try {
    const { body } = await cachedJsonFetch(
      `${JSR_API_URL}/scopes/${scope}/packages/${name}`,
      fetchOpts,
    );
    return body as JsrPackageDoc;
  } catch {
    return null;
  }
}

async function jsrVersionDoc(
  scope: string,
  name: string,
  version: string,
  fetchOpts: { cacheDir: string; ttlMs: number },
): Promise<JsrVersionDoc | null> {
  try {
    const { body } = await cachedJsonFetch(
      `${JSR_API_URL}/scopes/${scope}/packages/${name}/versions/${version}`,
      fetchOpts,
    );
    return body as JsrVersionDoc;
  } catch {
    return null;
  }
}

async function enrichJsrCandidate(
  fullName: string,
  requestedVersion: string | undefined,
  fetchOpts: { cacheDir: string; ttlMs: number },
): Promise<PkgFacts | { notFound: true; package: string }> {
  // JSR names are always scoped: @scope/name.
  const match = fullName.match(/^@([^/]+)\/(.+)$/);
  if (!match) return { notFound: true, package: fullName };
  const [, scope, name] = match;

  const pkgDoc = await jsrPackageDoc(scope, name, fetchOpts);
  if (!pkgDoc) return { notFound: true, package: fullName };

  const version = requestedVersion ?? pkgDoc.latestVersion ?? "latest";
  const versionDoc = await jsrVersionDoc(scope, name, version, fetchOpts);

  const vulns = await osvVulns(fullName, version, "JSR", fetchOpts);

  // JSR enforces SPDX licenses, native types, and provenance at publish time.
  // We mark these as trusted by emitting null for license (the gate engine's
  // jsrTrustedLicense path skips the check) and "native" for types.
  return {
    package: fullName,
    version,
    registry: "jsr",
    description: pkgDoc.description ?? null,
    license: null,
    weeklyDownloads: null,
    lastPublish: versionDoc?.createdAt ?? null,
    qualityScore: null,
    popularityScore: null,
    maintenanceScore: null,
    deprecated: versionDoc?.yanked === true,
    maintainerCount: 1,
    types: "native",
    vulns,
    repository: pkgDoc.githubRepository
      ? `https://github.com/${pkgDoc.githubRepository.owner}/${pkgDoc.githubRepository.name}`
      : null,
  };
}

/** One audited candidate: registry facts, gate blockers, verdict and rank score. */
export interface CandidateResult {
  facts: PkgFacts;
  blockers: string[];
  approved: boolean;
  score: number;
}

/** Sort order for candidates: approved first, then by descending score. */
export function compareCandidates(
  a: CandidateResult,
  b: CandidateResult,
): number {
  // Approved candidates rank above rejected ones regardless of score.
  if (a.approved !== b.approved) return a.approved ? -1 : 1;
  return b.score - a.score;
}

/** Shape ranked candidates into `evaluate`'s output, choosing `ok` or `ask_user`. */
export function buildOutput(
  ranked: CandidateResult[],
  unsafe: boolean,
): {
  action: "ok" | "ask_user";
  candidates: Record<string, unknown>[];
  message: string;
} {
  const candidates = ranked.map((c) => ({
    package: c.facts.package,
    version: c.facts.version,
    registry: c.facts.registry,
    description: c.facts.description,
    license: c.facts.license,
    weeklyDownloads: c.facts.weeklyDownloads,
    lastPublish: c.facts.lastPublish,
    qualityScore: c.facts.qualityScore,
    types: c.facts.types,
    approved: c.approved,
    score: c.score,
    rationale: buildRationale(c.facts, c.blockers),
    snippet: c.approved
      ? buildSnippet(c.facts.package, c.facts.version, c.facts.registry)
      : null,
    blockers: c.blockers,
    repository: c.facts.repository,
  }));
  const approvedCount = ranked.filter((c) => c.approved).length;
  const action: "ok" | "ask_user" = approvedCount > 0 || unsafe
    ? "ok"
    : "ask_user";
  const message = action === "ask_user"
    ? `No candidates passed trust gates (${ranked.length} evaluated). Tell the user which gates failed and ask how to proceed, or re-run with unsafe=true.`
    : `${approvedCount} of ${ranked.length} candidate(s) approved.`;
  return { action, candidates, message };
}

/** Wheelshop extension model. */
export const model = {
  type: "@bixu/wheelshop",
  version: "2026.10.13.3",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.10.13.3",
      description:
        "Add attribute, survey and smoosh methods; globalArguments unchanged",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    evaluation: {
      description: "Trust-gate audit of a single candidate package",
      schema: EvaluationSchema,
      lifetime: "1d" as const,
      garbageCollection: 50,
    },
    evaluationSummary: {
      description: "Summary of an evaluate run across multiple candidates",
      schema: SummarySchema,
      lifetime: "1d" as const,
      garbageCollection: 20,
    },
    attribution: {
      description:
        "Prior-art record and attribution check for a derived extension",
      schema: AttributionSchema,
      lifetime: "1d" as const,
      garbageCollection: 20,
    },
    survey: {
      description:
        "Ranked community extensions for a domain, a suggested base, and method overlap",
      schema: SurveySchema,
      lifetime: "1d" as const,
      garbageCollection: 20,
    },
    smoosh: {
      description:
        "Files written or kept, and remaining blockers, for a smooshed extension",
      schema: SmooshSchema,
      lifetime: "1d" as const,
      garbageCollection: 20,
    },
  },
  methods: {
    evaluate: {
      description:
        "Audit a list of candidate npm/jsr packages against trust gates (license, downloads, vulnerabilities, recency, types) and return ranked verdicts. Agents handle discovery and semantic relevance; this method only handles gating and scoring. If every candidate fails the gates, returns action='ask_user' so the agent knows to prompt a human.",
      arguments: EvaluateArgs,
      // deno-lint-ignore no-explicit-any
      execute: async (args: any, context: any) => {
        const ttlMs = (context.globalArgs.cacheTtlHours as number) *
          60 * 60 * 1000;
        const cacheDir = context.globalArgs.cacheDir as string;
        const fetchOpts = { cacheDir, ttlMs };

        context.logger.info(
          "wheelshop evaluate: {count} package(s), runtime={runtime}",
          { count: args.packages.length, runtime: args.runtime },
        );

        const EVALUATE_CONCURRENCY = 5;
        const results: CandidateResult[] = [];
        const notFound: string[] = [];

        for (let i = 0; i < args.packages.length; i += EVALUATE_CONCURRENCY) {
          const batch = args.packages.slice(i, i + EVALUATE_CONCURRENCY);
          const settled = await Promise.allSettled(
            batch.map((
              p: { name: string; version?: string; registry: "npm" | "jsr" },
            ) =>
              p.registry === "jsr"
                ? enrichJsrCandidate(p.name, p.version, fetchOpts)
                : enrichNpmCandidate(p.name, p.version, fetchOpts)
            ),
          );
          for (let j = 0; j < settled.length; j++) {
            const ref = batch[j];
            const result = settled[j];
            if (result.status === "rejected") {
              context.logger.warn("Skipping {pkg}: {err}", {
                pkg: ref.name,
                err: String(result.reason),
              });
              notFound.push(ref.name);
              continue;
            }
            const value = result.value;
            if ("notFound" in value) {
              notFound.push(value.package);
              continue;
            }
            const { blockers } = evaluateGates(value, DEFAULT_THRESHOLDS);
            const approved = args.unsafe || blockers.length === 0;
            const score = rankScore(value, args.runtime);
            results.push({ facts: value, blockers, approved, score });
          }
        }

        const ranked = results.slice().sort(compareCandidates);
        const { action, candidates, message } = buildOutput(
          ranked,
          args.unsafe,
        );

        const handles = [];
        for (const c of ranked) {
          const instance = sanitiseInstanceName(c.facts.package);
          const handle = await context.writeResource(
            "evaluation",
            instance,
            {
              package: c.facts.package,
              version: c.facts.version,
              registry: c.facts.registry,
              description: c.facts.description,
              license: c.facts.license,
              weeklyDownloads: c.facts.weeklyDownloads,
              lastPublish: c.facts.lastPublish,
              qualityScore: c.facts.qualityScore,
              types: c.facts.types,
              approved: c.approved,
              score: c.score,
              rationale: buildRationale(c.facts, c.blockers),
              snippet: c.approved
                ? buildSnippet(
                  c.facts.package,
                  c.facts.version,
                  c.facts.registry,
                )
                : null,
              blockers: c.blockers,
              repository: c.facts.repository,
            },
          );
          handles.push(handle);
        }

        // Prefix the summary instance with "summary-" so it can never collide
        // with a per-candidate evaluation instance name (which would happen
        // when there's exactly one candidate — both would hash from the same
        // package name).
        const summaryName = sanitiseInstanceName(
          "summary-" + (ranked.map((c) => c.facts.package).join("-") ||
            "evaluate"),
        );
        const summaryHandle = await context.writeResource(
          "evaluationSummary",
          summaryName,
          {
            action,
            packageCount: ranked.length,
            approvedCount: ranked.filter((c) => c.approved).length,
            message,
          },
        );

        const output = {
          action,
          message,
          candidates,
          notFound,
          thresholds: DEFAULT_THRESHOLDS,
        };

        await Deno.stdout.write(
          new TextEncoder().encode(JSON.stringify(output, null, 2) + "\n"),
        );

        return { dataHandles: [summaryHandle, ...handles] };
      },
    },
    attribute: {
      description:
        "Record prior art for an extension built from parts of community swamp extensions. Writes prior-art.yaml beside the manifest, then checks the manifest ships it, each derived file carries a 'Derived from <ext>@<version>' header, LICENSE.txt names each source, and each source license is permissive. Returns action='fix' with blockers when attribution is incomplete.",
      arguments: AttributeArgs,
      // deno-lint-ignore no-explicit-any
      execute: async (args: any, context: any) => {
        const { action, extension, priorArtPath, sources, blockers, message } =
          await recordAttribution(
            args.manifestPath,
            args.sources,
            context.repoDir,
            context.logger,
          );
        const handle = await context.writeResource(
          "attribution",
          sanitiseInstanceName(extension),
          { action, extension, priorArtPath, sources, blockers, message },
        );
        await Deno.stdout.write(
          new TextEncoder().encode(
            JSON.stringify(
              { action, message, blockers, priorArtPath },
              null,
              2,
            ) +
              "\n",
          ),
        );
        return { dataHandles: [handle] };
      },
    },
    survey: {
      description:
        "Survey the community swamp extensions for a domain through the swamp CLI (`extension search` + `extension info`). Ranks them (name matches the query, then official, then health: yanked, deprecated, superseded, stale, no repository), suggests the base to build on, marks which licenses allow copying code, and reports each candidate's method overlap with the base (likelyRedundant at 100%). Licenses missing from the registry are read from pulled copies at the latest version.",
      arguments: SurveyArgs,
      // deno-lint-ignore no-explicit-any
      execute: async (args: any, context: any) => {
        context.logger.info("wheelshop survey: {query}", { query: args.query });
        const search = await runSwamp(context.repoDir, [
          "extension",
          "search",
          args.query,
          "--per-page",
          String(args.limit),
        ]) as { extensions?: { name: string }[] };
        const names = (search.extensions ?? []).map((e) => e.name);

        const infos: SwampExtensionInfo[] = [];
        for (let i = 0; i < names.length; i += 5) {
          infos.push(
            ...await Promise.all(
              names.slice(i, i + 5).map((name) =>
                runSwamp(context.repoDir, ["extension", "info", name])
              ),
            ) as SwampExtensionInfo[],
          );
        }
        const licenses: Record<string, string | null> = {};
        for (const info of infos) {
          if (info.license) continue;
          licenses[info.name] = await pulledLicense(context.repoDir, {
            extension: info.name,
            version: info.latestVersion,
          });
        }

        const { base, candidates } = buildSurvey(args.query, infos, licenses);
        const message = base
          ? `Surveyed ${candidates.length} extension(s); suggested base ${base}.`
          : `Surveyed ${candidates.length} extension(s); no healthy extension with models to build on.`;
        const result = { query: args.query, base, candidates, message };
        const handle = await context.writeResource(
          "survey",
          sanitiseInstanceName(`survey-${args.query}`),
          result,
        );
        await Deno.stdout.write(
          new TextEncoder().encode(JSON.stringify(result, null, 2) + "\n"),
        );
        return { dataHandles: [handle] };
      },
    },
    smoosh: {
      description:
        "Build a derived extension from files of pulled community extensions. Copies each file from its pulled copy, adds a 'Derived from' header, swaps model types per `retarget`, rewires relative imports, appends each source's license to LICENSE.txt, merges the manifest (base as a dependency), then runs the `attribute` checks. Never overwrites a derived file that has been edited; it is kept and reported. Returns action='fix' with blockers for what still needs a human or agent, e.g. needs-adaptation when retargeted code reads the base model's stored data.",
      arguments: SmooshArgs,
      // deno-lint-ignore no-explicit-any
      execute: async (args: any, context: any) => {
        const out = (path: string) => `${args.outDir}/${path}`;
        const readOrNull = (path: string) =>
          Deno.readTextFile(path).catch(() => null);
        await Deno.mkdir(args.outDir, { recursive: true });
        context.logger.info("wheelshop smoosh: {count} source(s) into {dir}", {
          count: args.sources.length,
          dir: args.outDir,
        });

        const blockers: string[] = [];
        const written: string[] = [];
        const kept: string[] = [];
        const models: string[] = [];
        const helpers: string[] = [];
        const licensePath = out("LICENSE.txt");
        const ownLicense = await readOrNull(licensePath);
        let licenseText = ownLicense ?? "";
        if (ownLicense === null) {
          blockers.push(
            "own-license-missing (put your license at the top of LICENSE.txt)",
          );
        }

        for (const source of args.sources) {
          const root = await pulledRoot(context.repoDir, source);
          if (!root) {
            blockers.push(
              `not-pulled:${source.extension}@${source.version} (swamp extension pull it at that version)`,
            );
            continue;
          }
          const sourceLicense = await pulledLicenseText(
            context.repoDir,
            source,
          );
          source.license ??= sourceLicense === null
            ? null
            : detectSpdxLicense(sourceLicense);
          const fileMap: Record<string, string> = Object.fromEntries(
            source.files.map((
              f: { from: string; to: string },
            ) => [f.from, f.to]),
          );

          for (const { from, to } of source.files) {
            const original = await readOrNull(`${root}/${from}`);
            if (original === null) {
              blockers.push(`missing-source-file:${source.extension}/${from}`);
              continue;
            }
            const retargeted = retarget(original, source.retarget);
            const rewired = rewireImports(retargeted.text, from, fileMap);
            (isEntryPoint(original) ? models : helpers).push(to);

            const generated = `${smooshHeader(source, from)}\n${rewired.text}`;
            const existing = await readOrNull(out(to));
            if (existing === null) {
              await Deno.writeTextFile(out(to), generated);
              written.push(to);
            } else if (existing !== generated) {
              // Edited since smoosh wrote it: the edits are the fix, so keep
              // them and stop flagging what they were meant to address.
              kept.push(to);
              continue;
            }
            for (const spec of rewired.unmapped) {
              blockers.push(`unmapped-import:${to}(${spec})`);
            }
            if (
              retargeted.changed &&
              /readResource|readModelData|queryData|dataRepository/.test(
                original,
              )
            ) {
              blockers.push(
                `needs-adaptation:${to} (reads stored data of a retargeted type; check the new type's schema)`,
              );
            }
          }

          if (!licenseText.includes(source.extension)) {
            if (sourceLicense === null) {
              blockers.push(`no-license-text:${source.extension}`);
            } else {
              licenseText += licenseNotice(source, sourceLicense);
            }
          }
        }
        if (licenseText !== (ownLicense ?? "")) {
          await Deno.writeTextFile(licensePath, licenseText);
          written.push("LICENSE.txt");
        }

        const hasReadme = (await readOrNull(out("README.md"))) !== null;
        if (!hasReadme) blockers.push("readme-missing");
        const manifestPath = out("manifest.yaml");
        const manifestRaw = await readOrNull(manifestPath);
        const existingManifest = (parseYaml(manifestRaw ?? "{}") ??
          {}) as Record<string, unknown>;
        const merged = mergeManifest(existingManifest, {
          name: args.name,
          version: calverToday(),
          description: args.description,
          base: args.base,
          models,
          additionalFiles: [
            ...helpers,
            ...(hasReadme ? ["README.md"] : []),
            "LICENSE.txt",
            PRIOR_ART_FILE,
          ],
        });
        // Rewrite only on a real change, so a hand-edited manifest keeps its
        // comments and key order across re-runs.
        if (
          manifestRaw === null ||
          canonicalJson(merged) !== canonicalJson(existingManifest)
        ) {
          await Deno.writeTextFile(manifestPath, stringifyYaml(merged));
          written.push("manifest.yaml");
        }
        written.push(PRIOR_ART_FILE);

        const attribution = await recordAttribution(
          manifestPath,
          args.sources,
          context.repoDir,
          context.logger,
        );
        blockers.push(
          ...attribution.blockers.filter((b) => !blockers.includes(b)),
        );
        const action: "ok" | "fix" = blockers.length === 0 ? "ok" : "fix";
        const message = action === "ok"
          ? `Smooshed ${args.sources.length} source(s) into ${args.name}.`
          : `Smooshed into ${args.outDir}; ${blockers.length} item(s) need attention.`;
        const result = {
          action,
          extension: args.name,
          outDir: args.outDir,
          written,
          kept,
          blockers,
          message,
        };
        const handle = await context.writeResource(
          "smoosh",
          sanitiseInstanceName(args.name),
          result,
        );
        await Deno.stdout.write(
          new TextEncoder().encode(JSON.stringify(result, null, 2) + "\n"),
        );
        return { dataHandles: [handle] };
      },
    },
  },
};

/**
 * Run a swamp CLI command with `--json` and parse its output. survey uses the
 * stable CLI rather than the registry's undocumented HTTP API.
 */
export async function runSwamp(
  repoDir: string,
  args: string[],
): Promise<unknown> {
  // swamp-quality-ignore deno-command: survey calls the stable swamp CLI by design, not the undocumented registry API
  const { code, stdout, stderr } = await new Deno.Command("swamp", {
    args: [...args, "--json"],
    cwd: repoDir,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(stdout);
  if (code !== 0) {
    throw new Error(
      `swamp ${args.join(" ")} failed (exit ${code}): ${
        text || new TextDecoder().decode(stderr)
      }`,
    );
  }
  return JSON.parse(text);
}

/**
 * Write `prior-art.yaml` beside the manifest and check that every source is
 * credited. Sources without a license get one from their pulled copy.
 */
export async function recordAttribution(
  manifestPath: string,
  sources: PriorArtSource[],
  repoDir: string,
  // deno-lint-ignore no-explicit-any
  logger: any,
) {
  for (const source of sources) {
    if (source.license) continue;
    source.license = await pulledLicense(repoDir, source);
    logger.info(
      "License for {ext}@{version} from its pulled copy: {license} (null = not found)",
      { ...source, ext: source.extension },
    );
  }
  logger.info("wheelshop attribute: {count} source(s) for {manifest}", {
    count: sources.length,
    manifest: manifestPath,
  });
  // Manifest-relative paths; paths.base: manifest puts files beside it.
  const slash = manifestPath.lastIndexOf("/");
  const dir = slash === -1 ? "." : manifestPath.slice(0, slash);
  const inDir = (path: string) => `${dir}/${path}`;
  // An empty manifest parses to null; treat it as having no fields.
  const manifest = (parseYaml(await Deno.readTextFile(manifestPath)) ??
    {}) as { name?: string; additionalFiles?: string[] };

  const priorArtPath = inDir(PRIOR_ART_FILE);
  // Record only the fields prior art needs, not smoosh's retarget map.
  const record = sources.map(
    ({ extension, version, repository, license, files }) => ({
      extension,
      version,
      repository,
      license,
      files: files.map(({ from, to }) => ({ from, to })),
    }),
  );
  await Deno.writeTextFile(
    priorArtPath,
    stringifyYaml({ derivedFrom: record }),
  );

  const readOrNull = (path: string) =>
    Deno.readTextFile(inDir(path)).catch(() => null);
  const derivedFiles: Record<string, string | null> = {};
  for (const { files } of sources) {
    for (const { to } of files) derivedFiles[to] = await readOrNull(to);
  }

  const blockers = checkAttribution({
    sources,
    additionalFiles: manifest.additionalFiles ?? [],
    derivedFiles,
    licenseText: await readOrNull("LICENSE.txt"),
  });
  const action: "ok" | "fix" = blockers.length === 0 ? "ok" : "fix";
  const message = action === "ok"
    ? `Prior art recorded for ${sources.length} source(s).`
    : `Prior art written to ${priorArtPath}; fix ${blockers.length} attribution gap(s) before publishing.`;
  return {
    action,
    extension: manifest.name ?? manifestPath,
    priorArtPath,
    sources: record,
    blockers,
    message,
  };
}

/**
 * Root of a source's pulled copy in this repo, or null unless the pulled
 * version is exactly the one the code is taken from.
 * shortcut: assumes swamp's `.swamp/pulled-extensions/<name>/` layout (no API
 * exposes another extension's files); switch if swamp adds one.
 */
export async function pulledRoot(
  repoDir: string,
  source: { extension: string; version: string },
): Promise<string | null> {
  const root = `${repoDir}/.swamp/pulled-extensions/${source.extension}`;
  try {
    const pulled = parseYaml(
      await Deno.readTextFile(`${root}/manifest.yaml`),
    ) as { version?: unknown } | null;
    return String(pulled?.version) === source.version ? root : null;
  } catch {
    return null;
  }
}

/** Text of a pulled source's LICENSE file, or null when absent. */
export async function pulledLicenseText(
  repoDir: string,
  source: { extension: string; version: string },
): Promise<string | null> {
  const root = await pulledRoot(repoDir, source);
  if (!root) return null;
  try {
    for await (const entry of Deno.readDir(`${root}/files`)) {
      if (entry.isFile && /^licen[cs]e/i.test(entry.name)) {
        return await Deno.readTextFile(`${root}/files/${entry.name}`);
      }
    }
  } catch {
    // No files directory: no license.
  }
  return null;
}

/**
 * SPDX id of a source's license, read from its pulled copy (see `pulledRoot`
 * for the version rule).
 */
export async function pulledLicense(
  repoDir: string,
  source: { extension: string; version: string },
): Promise<string | null> {
  const text = await pulledLicenseText(repoDir, source);
  return text === null ? null : detectSpdxLicense(text);
}

/**
 * Instance names map directly to filesystem paths in swamp's data store, so
 * strip characters that would create unwanted nesting or are not safe across
 * platforms.
 */
export function sanitiseInstanceName(input: string): string {
  const clean = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  const suffix = fnv1a32(input).slice(0, 8);
  return `${clean || "wheelshop"}-${suffix}`;
}
