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
 * Single method:
 * - **evaluate** — given a list of `{name, version?, registry?}` candidates,
 *   audit each against the trust gates and return ranked verdicts.
 *
 * When every candidate fails the gates, the model returns `action: "ask_user"`
 * so the calling agent knows to prompt a human rather than silently fall back
 * to a custom implementation.
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
  maintainerCount,
  normaliseVulns,
  type PkgFacts,
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

export function extractRepo(manifest: NpmManifest | null): string | null {
  if (!manifest) return null;
  if (typeof manifest.repository === "string") return manifest.repository;
  if (manifest.repository && typeof manifest.repository === "object") {
    return manifest.repository.url ?? null;
  }
  return null;
}

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

export interface CandidateResult {
  facts: PkgFacts;
  blockers: string[];
  approved: boolean;
  score: number;
}

export function compareCandidates(
  a: CandidateResult,
  b: CandidateResult,
): number {
  // Approved candidates rank above rejected ones regardless of score.
  if (a.approved !== b.approved) return a.approved ? -1 : 1;
  return b.score - a.score;
}

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
  version: "2026.06.07.1",
  globalArguments: GlobalArgsSchema,
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
  },
};

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
