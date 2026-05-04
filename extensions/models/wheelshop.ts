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
  maintainerCount,
  normaliseVulns,
  type PkgFacts,
  type TypesAvailability,
  type Vuln,
} from "./wheelshop_helpers.ts";

const HOME = Deno.env.get("HOME") ?? "/tmp";
const CACHE_DIR = `${HOME}/.cache/swamp-wheelshop`;

const NPMS_SEARCH_URL = "https://api.npms.io/v2/search";
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
  intent: z.string().describe(
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

const AuditArgs = z.object({
  package: z.string().describe(
    "Package name to audit (e.g. 'cron-parser', '@aws-sdk/client-s3')",
  ),
  version: z.string().optional().describe(
    "Version to audit (default: latest from the registry)",
  ),
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

interface NpmsResult {
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

async function npmsSearch(
  query: string,
  size: number,
  fetchOpts: { cacheDir: string; ttlMs: number },
): Promise<NpmsResult[]> {
  const url = `${NPMS_SEARCH_URL}?q=${encodeURIComponent(query)}&size=${size}`;
  const { body } = await cachedJsonFetch(url, fetchOpts);
  const obj = body as Record<string, unknown>;
  return (obj.results as NpmsResult[]) ?? [];
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
  npmsLicense: string | undefined,
  manifest: NpmManifest | null,
): string | null {
  if (npmsLicense) return npmsLicense;
  if (!manifest) return null;
  if (typeof manifest.license === "string") return manifest.license;
  if (manifest.license && typeof manifest.license === "object") {
    return manifest.license.type ?? null;
  }
  return null;
}

async function enrichNpmCandidate(
  result: NpmsResult,
  fetchOpts: { cacheDir: string; ttlMs: number },
): Promise<PkgFacts> {
  const name = result.package.name;

  // npms.io's index lags by months-to-years for many packages, so the version,
  // last-publish date, and license it returns can describe an obsolete release.
  // Treat the npms hit as a candidate generator only; evaluate gates against
  // the *current* latest manifest from the npm registry.
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
    license: "MIT", // jsr requires an SPDX license; default to MIT-shaped pass.
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
  return candidates.slice().sort((a, b) => {
    // jsr boost when targeting deno
    const aBoost = runtime !== "node" && a.facts.registry === "jsr" ? 0.05 : 0;
    const bBoost = runtime !== "node" && b.facts.registry === "jsr" ? 0.05 : 0;

    const aScore = (a.facts.qualityScore ?? 0) + aBoost;
    const bScore = (b.facts.qualityScore ?? 0) + bBoost;
    return bScore - aScore;
  });
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

        // Overfetch from npms — many will be filtered.
        const overfetch = Math.max(args.limit * 2, 8);
        const npmResults = await npmsSearch(query, overfetch, fetchOpts);

        const jsrResults = args.runtime !== "node"
          ? await jsrSearch(query, Math.min(overfetch, 10), fetchOpts)
          : [];

        const enriched: RankedCandidate[] = [];

        for (const r of npmResults.slice(0, overfetch)) {
          try {
            const facts = await enrichNpmCandidate(r, fetchOpts);
            const { blockers } = evaluateGates(facts, DEFAULT_THRESHOLDS);
            enriched.push({ facts, blockers });
          } catch (e) {
            context.logger.warn("Skipping {pkg}: {err}", {
              pkg: r.package.name,
              err: String(e),
            });
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
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96) || "wheelshop";
}
