/**
 * @module
 * Wheelshop — community-TS guardrail for swamp extension authors.
 *
 * Helps agents discover proven npm/jsr libraries instead of
 * reinventing logic in swamp-native TypeScript. Recommendations are filtered
 * through trust gates (downloads, license, recency, maintenance, OSV
 * vulnerabilities, type availability). When all candidates fail the gates,
 * the model returns `action: "ask_user"` so the calling agent knows to
 * prompt a human rather than silently fall back to a custom implementation.
 *
 * Two methods:
 * - **search** — given a plain-English intent, return ranked candidates.
 * - **audit**  — given a specific package + version, evaluate it.
 *
 * Why not reinvent these in swamp? Because that's exactly what wheelshop is
 * here to prevent.
 */
import { z } from "npm:zod@4";
import {
  buildRationale,
  buildSnippet,
  cachedJsonFetch,
  DEFAULT_THRESHOLDS,
  detectTypes,
  evaluateGates,
  fnv1a32,
  intentMatches,
  maintainerCount,
  normaliseVulns,
  type PkgFacts,
  rankScore,
  tokenizeIntent,
  type TypesAvailability,
  type Vuln,
} from "../wheelshop/wheelshop_helpers.ts";

const HOME = Deno.env.get("HOME") ?? "/tmp";
const CACHE_DIR = `${HOME}/.cache/swamp-wheelshop`;

const NPM_SEARCH_URL = "https://registry.npmjs.org/-/v1/search";
const NPM_REGISTRY_URL = "https://registry.npmjs.org";
const NPM_DOWNLOADS_URL = "https://api.npmjs.org/downloads/point/last-week";
const OSV_QUERY_URL = "https://api.osv.dev/v1/query";
const JSR_SEARCH_URL = "https://jsr.io/api/packages";

const GlobalArgsSchema = z.object({
  cacheDir: z.string().default(CACHE_DIR).describe(
    "Directory for the 24h fetch cache",
  ),
  cacheTtlHours: z.number().default(24).describe(
    "How long cached registry responses stay fresh, in hours",
  ),
});

const SearchArgs = z.object({
  intent: z.string().min(1, "intent cannot be empty").describe(
    "Plain-English description of what you need a library for (e.g. 'parse cron expressions', 'retry with backoff')",
  ),
  keywords: z.array(z.string()).default([]).describe(
    "Optional extra keywords to refine the search",
  ),
  runtime: z.enum(["deno", "node", "both"]).default("both").describe(
    "Target runtime — affects scoring; jsr is preferred when 'deno' or 'both'",
  ),
  limit: z.number().int().min(1).max(20).default(5).describe(
    "Max candidates to return after filtering",
  ),
  unsafe: z.boolean().default(false).describe(
    "Include candidates that fail trust gates (DO NOT enable without explicit user approval)",
  ),
});

// npm package names: scoped (@scope/name) or unscoped (name)
// No "..", no bare "/", no whitespace, no control characters.
const NPM_PKG_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
// npm versions: semver (starts with digit) or dist-tag (starts with letter)
// Reject anything containing slashes, spaces, or ".."
const NPM_VER_RE = /^[a-zA-Z0-9][a-zA-Z0-9._+\-]*$/;

const AuditArgs = z.object({
  package: z.string()
    .regex(NPM_PKG_RE, "invalid npm package name")
    .describe(
      "Package name to audit (e.g. 'cron-parser', '@aws-sdk/client-s3')",
    ),
  version: z.string()
    .regex(NPM_VER_RE, "invalid npm version or dist-tag")
    .optional()
    .describe("Version to audit (default: latest from the registry)"),
  unsafe: z.boolean().default(false).describe(
    "Report blockers but mark approved=true regardless",
  ),
});

const RecommendationSchema = z.object({
  intent: z.string(),
  package: z.string(),
  version: z.string(),
  registry: z.string(),
  description: z.string().nullable(),
  license: z.string().nullable(),
  weeklyDownloads: z.number().nullable(),
  lastPublish: z.string().nullable(),
  qualityScore: z.number().nullable(),
  types: z.string(),
  rationale: z.string(),
  snippet: z.string(),
  blockers: z.array(z.string()),
  repository: z.string().nullable(),
}).passthrough();

const SearchSummarySchema = z.object({
  intent: z.string(),
  action: z.enum(["ok", "ask_user"]),
  candidatesCount: z.number(),
  rejectedCount: z.number(),
  message: z.string(),
});

const AuditReportSchema = z.object({
  package: z.string(),
  version: z.string(),
  approved: z.boolean(),
  blockers: z.array(z.string()),
  facts: z.any(),
});

interface RegistrySearchHit {
  package: {
    name: string;
    version: string;
    description?: string;
    date?: string;
    license?: string;
    maintainers?: unknown[];
    links?: { repository?: string };
  };
  score?: {
    final?: number;
    detail?: { quality?: number; popularity?: number; maintenance?: number };
  };
}

/**
 * Search the npm registry's official search endpoint with popularity-heavy
 * weighting so widely-installed packages rank above niche literal-match
 * results. Score detail (quality/popularity/maintenance) flows through to
 * downstream gating.
 */
async function npmRegistrySearch(
  query: string,
  size: number,
  fetchOpts: { cacheDir: string; ttlMs: number },
): Promise<RegistrySearchHit[]> {
  const params = new URLSearchParams({
    text: query,
    size: String(size),
    popularity: "1.0",
    quality: "0.5",
    maintenance: "0.5",
  });
  const url = `${NPM_SEARCH_URL}?${params.toString()}`;
  const { body } = await cachedJsonFetch(url, fetchOpts);
  const obj = body as Record<string, unknown>;
  const objects = obj.objects;
  return Array.isArray(objects) ? objects as RegistrySearchHit[] : [];
}

/**
 * Run the full intent query plus each individual term as its own query, then
 * merge the unique packages. npm's search is a literal multi-word matcher, so
 * "mqtt client" excludes the canonical package literally named `mqtt`. Probing
 * each term separately surfaces those single-word-named packages.
 */
async function npmRegistrySearchMulti(
  intent: string,
  sizePerQuery: number,
  fetchOpts: { cacheDir: string; ttlMs: number },
): Promise<RegistrySearchHit[]> {
  const queries = new Set<string>([intent.trim()]);
  for (const term of tokenizeIntent(intent)) {
    queries.add(term);
  }

  const all = await Promise.all(
    Array.from(queries).map((q) =>
      npmRegistrySearch(q, sizePerQuery, fetchOpts).catch(() =>
        [] as RegistrySearchHit[]
      )
    ),
  );

  const byName = new Map<string, RegistrySearchHit>();
  for (const hits of all) {
    for (const hit of hits) {
      const name = hit.package.name;
      if (!byName.has(name)) byName.set(name, hit);
    }
  }
  return Array.from(byName.values());
}

async function npmDownloads(
  pkg: string,
  fetchOpts: { cacheDir: string; ttlMs: number },
): Promise<number | null> {
  // Both `@scope/name` and `name` must appear literally in the path; the
  // npm downloads API does not accept percent-encoded scope/name characters.
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

interface NpmManifest {
  types?: string;
  typings?: string;
  exports?: unknown;
  deprecated?: string | boolean;
  repository?: { url?: string } | string;
  license?: string | { type?: string };
  maintainers?: unknown[];
  version: string;
}

async function npmLatestManifest(
  pkg: string,
  version: string | undefined,
  fetchOpts: { cacheDir: string; ttlMs: number },
): Promise<NpmManifest | null> {
  // npm registry expects literal `@scope/name`; do not percent-encode.
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

/**
 * Fetch the published date for a specific version from the npm registry's
 * full package doc. The abbreviated `vnd.npm.install-v1+json` view strips
 * the `time` map, so we have to take the larger payload (cached for 24h).
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
  fetchOpts: { cacheDir: string; ttlMs: number },
): Promise<Vuln[]> {
  try {
    const { body } = await cachedJsonFetch(OSV_QUERY_URL, {
      ...fetchOpts,
      init: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          package: { name: pkg, ecosystem: "npm" },
          version,
        }),
      },
    });
    return normaliseVulns(body);
  } catch {
    return [];
  }
}

function extractRepo(manifest: NpmManifest | null): string | null {
  if (!manifest) return null;
  if (typeof manifest.repository === "string") return manifest.repository;
  if (manifest.repository && typeof manifest.repository === "object") {
    return manifest.repository.url ?? null;
  }
  return null;
}

function extractLicense(
  hintLicense: string | undefined,
  manifest: NpmManifest | null,
): string | null {
  if (hintLicense) return hintLicense;
  if (!manifest) return null;
  if (typeof manifest.license === "string") return manifest.license;
  if (manifest.license && typeof manifest.license === "object") {
    return manifest.license.type ?? null;
  }
  return null;
}

async function enrichNpmCandidate(
  result: RegistrySearchHit,
  fetchOpts: { cacheDir: string; ttlMs: number },
): Promise<PkgFacts> {
  const name = result.package.name;

  // The search hit's `version` reflects whatever the search index had at scrape
  // time. Treat it as a candidate generator only; evaluate gates against the
  // *current* latest manifest from the npm registry.
  const latestManifest = await npmLatestManifest(name, undefined, fetchOpts);
  const version = latestManifest?.version ?? result.package.version;

  const [downloads, vulns, lastPublish] = await Promise.all([
    npmDownloads(name, fetchOpts),
    osvVulns(name, version, fetchOpts),
    npmPublishDate(name, version, fetchOpts),
  ]);

  const types: TypesAvailability = latestManifest
    ? detectTypes(latestManifest)
    : "none";
  const deprecated = !!latestManifest?.deprecated;

  return {
    package: name,
    version,
    registry: "npm",
    description: result.package.description ?? null,
    license: extractLicense(undefined, latestManifest) ??
      result.package.license ?? null,
    weeklyDownloads: downloads,
    lastPublish: lastPublish ?? result.package.date ?? null,
    qualityScore: result.score?.detail?.quality ?? null,
    popularityScore: result.score?.detail?.popularity ?? null,
    maintenanceScore: result.score?.detail?.maintenance ?? null,
    deprecated,
    maintainerCount: latestManifest
      ? maintainerCount(latestManifest.maintainers)
      : maintainerCount(result.package.maintainers),
    types,
    vulns,
    repository: extractRepo(latestManifest) ??
      result.package.links?.repository ??
      null,
  };
}

interface JsrPackageHit {
  scope: string;
  name: string;
  description?: string;
  latestVersion?: string;
  score?: number | null;
}

async function jsrSearch(
  query: string,
  limit: number,
  fetchOpts: { cacheDir: string; ttlMs: number },
): Promise<JsrPackageHit[]> {
  try {
    const url = `${JSR_SEARCH_URL}?query=${
      encodeURIComponent(query)
    }&limit=${limit}`;
    const { body } = await cachedJsonFetch(url, fetchOpts);
    const items = (body as Record<string, unknown>).items;
    return Array.isArray(items) ? items as JsrPackageHit[] : [];
  } catch {
    return [];
  }
}

function jsrToFacts(hit: JsrPackageHit): PkgFacts {
  // jsr enforces TS-native + provenance + no install scripts at the registry
  // level, so most trust gates pass by construction. Downloads and OSV data
  // are not currently exposed; we leave them null so they don't block.
  return {
    package: `@${hit.scope}/${hit.name}`,
    version: hit.latestVersion ?? "latest",
    registry: "jsr",
    description: hit.description ?? null,
    license: null,
    // JSR requires an SPDX license; evaluateGates skips the license gate for
    // JSR packages with null license via the jsrTrustedLicense path.
    weeklyDownloads: null,
    lastPublish: null,
    qualityScore: typeof hit.score === "number" ? hit.score / 100 : null,
    popularityScore: null,
    maintenanceScore: null,
    deprecated: false,
    maintainerCount: 1,
    types: "native",
    vulns: [],
    repository: null,
  };
}

interface RankedCandidate {
  facts: PkgFacts;
  blockers: string[];
}

function rankCandidates(
  candidates: RankedCandidate[],
  runtime: "deno" | "node" | "both",
): RankedCandidate[] {
  return candidates.slice().sort(
    (a, b) => rankScore(b.facts, runtime) - rankScore(a.facts, runtime),
  );
}

function recommendationFromCandidate(
  intent: string,
  c: RankedCandidate,
): Record<string, unknown> {
  return {
    intent,
    package: c.facts.package,
    version: c.facts.version,
    registry: c.facts.registry,
    description: c.facts.description,
    license: c.facts.license,
    weeklyDownloads: c.facts.weeklyDownloads,
    lastPublish: c.facts.lastPublish,
    qualityScore: c.facts.qualityScore,
    types: c.facts.types,
    rationale: buildRationale(c.facts, c.blockers),
    snippet: buildSnippet(c.facts.package, c.facts.version, c.facts.registry),
    blockers: c.blockers,
    repository: c.facts.repository,
  };
}

/** Wheelshop extension model. */
export const model = {
  type: "@bixu/wheelshop",
  version: "2026.05.04.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    recommendation: {
      description: "A single library recommendation for a stated intent",
      schema: RecommendationSchema,
      lifetime: "1d" as const,
      garbageCollection: 50,
    },
    searchSummary: {
      description: "Summary of a wheelshop search",
      schema: SearchSummarySchema,
      lifetime: "1d" as const,
      garbageCollection: 20,
    },
    auditReport: {
      description: "Trust-gate audit of a specific package version",
      schema: AuditReportSchema,
      lifetime: "1d" as const,
      garbageCollection: 50,
    },
  },
  methods: {
    search: {
      description:
        "Search npm/jsr for community libraries matching an intent, filter by trust gates, and return ranked recommendations. If all candidates fail the gates, returns action='ask_user' so the agent knows to prompt a human.",
      arguments: SearchArgs,
      execute: async (args, context) => {
        const ttlMs = (context.globalArgs.cacheTtlHours as number) *
          60 * 60 * 1000;
        const cacheDir = context.globalArgs.cacheDir as string;
        const fetchOpts = { cacheDir, ttlMs };

        const query = [args.intent, ...args.keywords].join(" ").trim();
        context.logger.info(
          "wheelshop search: {query} (runtime={runtime}, limit={limit})",
          { query, runtime: args.runtime, limit: args.limit },
        );

        // Overfetch from npm — many will be filtered.
        const overfetch = Math.max(args.limit * 2, 8);
        const npmResultsRaw = await npmRegistrySearchMulti(
          query,
          overfetch,
          fetchOpts,
        );

        // npm's multi-term search is a literal AND-matcher; running each term
        // separately surfaces canonical packages but also pulls in mass-popular
        // packages whose names happen to share a single generic term (every
        // `*-client` package surfaces from the "client" sub-query). Require
        // every intent term to appear in the package name or description.
        const npmResults = npmResultsRaw.filter((hit) =>
          intentMatches(args.intent, {
            name: hit.package.name,
            description: hit.package.description,
          })
        );

        // JSR's index is small enough that single-term matches often return
        // packages with nothing to do with the intent. Same filter applies.
        const jsrResultsRaw = args.runtime !== "node"
          ? await jsrSearch(query, Math.min(overfetch, 10), fetchOpts)
          : [];
        const jsrResults = jsrResultsRaw.filter((hit) =>
          intentMatches(args.intent, {
            name: `${hit.scope}/${hit.name}`,
            description: hit.description,
          })
        );

        // Enrich every unique npm candidate the multi-query produced. With
        // overfetch=10 per query and 2-3 queries after stopword removal, the
        // unique pool is typically 15-30 packages — every fetch is cached for
        // 24h so re-runs are cheap, and trimming here would discard the
        // canonical-name matches that single-term queries surface.
        const enriched: RankedCandidate[] = [];

        const ENRICH_CONCURRENCY = 5;
        for (let i = 0; i < npmResults.length; i += ENRICH_CONCURRENCY) {
          const batch = npmResults.slice(i, i + ENRICH_CONCURRENCY);
          const settled = await Promise.allSettled(
            batch.map((r) => enrichNpmCandidate(r, fetchOpts)),
          );
          for (let j = 0; j < settled.length; j++) {
            const result = settled[j];
            if (result.status === "fulfilled") {
              const facts = result.value;
              const { blockers } = evaluateGates(facts, DEFAULT_THRESHOLDS);
              enriched.push({ facts, blockers });
            } else {
              context.logger.warn("Skipping {pkg}: {err}", {
                pkg: batch[j].package.name,
                err: String(result.reason),
              });
            }
          }
        }

        for (const hit of jsrResults) {
          const facts = jsrToFacts(hit);
          const { blockers } = evaluateGates(facts, DEFAULT_THRESHOLDS);
          enriched.push({ facts, blockers });
        }

        const ranked = rankCandidates(enriched, args.runtime);
        const passing = ranked.filter((c) => c.blockers.length === 0);
        const rejected = ranked.filter((c) => c.blockers.length > 0);

        const accepted = args.unsafe
          ? ranked.slice(0, args.limit)
          : passing.slice(0, args.limit);

        const handles = [];
        for (const cand of accepted) {
          const rec = recommendationFromCandidate(args.intent, cand);
          const handle = await context.writeResource(
            "recommendation",
            sanitiseInstanceName(`${args.intent}-${cand.facts.package}`),
            rec,
          );
          handles.push(handle);
        }

        const action: "ok" | "ask_user" = accepted.length === 0 && !args.unsafe
          ? "ask_user"
          : "ok";

        const message = action === "ask_user"
          ? `No candidates passed trust gates for "${args.intent}" (${rejected.length} evaluated). Ask the user before falling back to a custom implementation, or pass unsafe=true to allow blocked candidates.`
          : `Returning ${accepted.length} candidate(s) for "${args.intent}".`;

        const summaryHandle = await context.writeResource(
          "searchSummary",
          sanitiseInstanceName(args.intent),
          {
            intent: args.intent,
            action,
            candidatesCount: accepted.length,
            rejectedCount: rejected.length,
            message,
          },
        );

        const output = {
          intent: args.intent,
          action,
          message,
          candidates: accepted.map((c) =>
            recommendationFromCandidate(args.intent, c)
          ),
          rejected: rejected.map((c) => ({
            package: c.facts.package,
            version: c.facts.version,
            registry: c.facts.registry,
            blockers: c.blockers,
          })),
          thresholds: DEFAULT_THRESHOLDS,
        };

        await Deno.stdout.write(
          new TextEncoder().encode(JSON.stringify(output, null, 2) + "\n"),
        );

        return { dataHandles: [summaryHandle, ...handles] };
      },
    },

    audit: {
      description:
        "Audit a specific npm package + version against the same trust gates used by search. Useful for validating an existing dependency or a candidate the agent already has in mind.",
      arguments: AuditArgs,
      execute: async (args, context) => {
        const ttlMs = (context.globalArgs.cacheTtlHours as number) *
          60 * 60 * 1000;
        const cacheDir = context.globalArgs.cacheDir as string;
        const fetchOpts = { cacheDir, ttlMs };

        context.logger.info("wheelshop audit: {pkg}@{ver}", {
          pkg: args.package,
          ver: args.version ?? "latest",
        });

        const manifest = await npmLatestManifest(
          args.package,
          args.version,
          fetchOpts,
        );
        if (!manifest) {
          throw new Error(
            `Could not fetch manifest for ${args.package}@${
              args.version ?? "latest"
            }`,
          );
        }
        // If the caller requested a concrete semver version, verify the
        // registry returned exactly that version. Dist-tags like "latest" are
        // allowed to resolve freely; semver pins must match exactly.
        if (
          args.version && /^\d/.test(args.version) &&
          manifest.version !== args.version
        ) {
          throw new Error(
            `Version mismatch: requested ${args.version} but registry resolved to ${manifest.version}. ` +
              `The requested version may not exist.`,
          );
        }
        const version = manifest.version ?? args.version ?? "latest";

        const [downloads, vulns, lastPublish] = await Promise.all([
          npmDownloads(args.package, fetchOpts),
          osvVulns(args.package, version, fetchOpts),
          npmPublishDate(args.package, version, fetchOpts),
        ]);

        const facts: PkgFacts = {
          package: args.package,
          version,
          registry: "npm",
          description: null,
          license: extractLicense(undefined, manifest),
          weeklyDownloads: downloads,
          lastPublish,
          qualityScore: null,
          popularityScore: null,
          maintenanceScore: null,
          deprecated: !!manifest.deprecated,
          maintainerCount: maintainerCount(manifest.maintainers),
          types: detectTypes(manifest),
          vulns,
          repository: extractRepo(manifest),
        };

        const { blockers } = evaluateGates(facts, DEFAULT_THRESHOLDS);
        const approved = args.unsafe || blockers.length === 0;

        const report = {
          package: facts.package,
          version: facts.version,
          approved,
          blockers,
          facts,
        };

        const handle = await context.writeResource(
          "auditReport",
          sanitiseInstanceName(`${facts.package}-${facts.version}`),
          report,
        );

        await Deno.stdout.write(
          new TextEncoder().encode(JSON.stringify(report, null, 2) + "\n"),
        );

        return { dataHandles: [handle] };
      },
    },
  },
};

/**
 * Instance names map directly to filesystem paths in swamp's data store, so
 * we strip characters that would create unwanted nesting or are not safe
 * across platforms.
 */
function sanitiseInstanceName(input: string): string {
  const clean = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  const suffix = fnv1a32(input).slice(0, 8);
  return `${clean || "wheelshop"}-${suffix}`;
}
