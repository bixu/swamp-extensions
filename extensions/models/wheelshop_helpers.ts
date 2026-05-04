/**
 * @module
 * Pure helpers for the @bixu/wheelshop extension model.
 *
 * Logic that does not need swamp's runtime context lives here so it can be
 * unit-tested without network or filesystem access.
 */

export const LICENSE_ALLOWLIST: ReadonlySet<string> = new Set([
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "0BSD",
  "MPL-2.0",
  "Unlicense",
  "CC0-1.0",
]);

export interface Thresholds {
  minWeeklyDownloads: number;
  maxAgeMonths: number;
  minMaintenance: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  minWeeklyDownloads: 1000,
  maxAgeMonths: 24,
  minMaintenance: 0.4,
};

/**
 * Split an SPDX license expression into its constituent license terms.
 * Handles `OR`, `AND`, `WITH`, and parentheses.
 */
export function parseSpdxLicense(
  license: string | null | undefined,
): string[] {
  if (!license) return [];
  return license
    .replace(/[()]/g, " ")
    .split(/\s+(?:AND|OR|WITH)\s+/i)
    .map((term) => term.trim())
    .filter(Boolean);
}

/**
 * A license string is allowed only when every constituent term is on the
 * allowlist. Conservative: an `AND` combination requires both terms allowed.
 */
export function licenseAllowed(license: string | null | undefined): boolean {
  const terms = parseSpdxLicense(license);
  if (terms.length === 0) return false;
  return terms.every((term) => LICENSE_ALLOWLIST.has(term));
}

/** Approximate months elapsed since `iso`. */
export function monthsSince(iso: string, now = new Date()): number {
  const then = new Date(iso);
  const diffMs = now.getTime() - then.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24 * 30.44));
}

export type TypesAvailability = "native" | "@types" | "none";

export interface Vuln {
  id: string;
  /** "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | "UNKNOWN" */
  severity: string;
}

export interface PkgFacts {
  package: string;
  version: string;
  registry: "npm" | "jsr";
  description: string | null;
  license: string | null;
  weeklyDownloads: number | null;
  lastPublish: string | null;
  qualityScore: number | null;
  popularityScore: number | null;
  maintenanceScore: number | null;
  deprecated: boolean;
  maintainerCount: number;
  types: TypesAvailability;
  vulns: Vuln[];
  repository: string | null;
}

export interface GateResult {
  blockers: string[];
}

/**
 * Apply trust gates to a candidate. Returns the list of blocker reasons.
 * An empty list means the candidate passes all gates.
 */
export function evaluateGates(
  facts: PkgFacts,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
  now: Date = new Date(),
): GateResult {
  const blockers: string[] = [];

  if (facts.deprecated) blockers.push("deprecated");

  // JSR's registry mandates SPDX licenses at publish time, so a null license
  // from JSR reflects our own decision not to surface it (we don't fetch it),
  // not an actual missing license. Trust JSR's enforcement in that case.
  const jsrTrustedLicense = facts.registry === "jsr" && facts.license === null;
  if (!jsrTrustedLicense && !licenseAllowed(facts.license)) {
    blockers.push(`license:${facts.license ?? "unknown"}`);
  }

  if (facts.types === "none") blockers.push("no-types");

  if (facts.maintainerCount === 0) blockers.push("no-maintainers");

  if (
    facts.weeklyDownloads !== null &&
    facts.weeklyDownloads < thresholds.minWeeklyDownloads
  ) {
    blockers.push(
      `low-downloads:${facts.weeklyDownloads}<${thresholds.minWeeklyDownloads}`,
    );
  }

  if (facts.lastPublish) {
    const ageMonths = monthsSince(facts.lastPublish, now);
    if (ageMonths > thresholds.maxAgeMonths) {
      blockers.push(`unmaintained:${ageMonths}mo>${thresholds.maxAgeMonths}mo`);
    }
  }

  if (
    facts.maintenanceScore !== null &&
    facts.maintenanceScore < thresholds.minMaintenance
  ) {
    blockers.push(
      `low-maintenance:${
        facts.maintenanceScore.toFixed(2)
      }<${thresholds.minMaintenance}`,
    );
  }

  for (const v of facts.vulns) {
    const sev = (v.severity || "UNKNOWN").toUpperCase();
    if (sev === "HIGH" || sev === "CRITICAL" || sev === "UNKNOWN") {
      blockers.push(`vuln:${v.id}:${sev}`);
    }
  }

  return { blockers };
}

/**
 * Map a CVSS v3 base score to a severity label. OSV severity entries don't
 * always include a label, but they always include the numeric score.
 */
export function cvssToSeverity(score: number): string {
  if (score >= 9.0) return "CRITICAL";
  if (score >= 7.0) return "HIGH";
  if (score >= 4.0) return "MEDIUM";
  if (score > 0.0) return "LOW";
  return "UNKNOWN";
}

/** Hex SHA-256 of a string — used for cache keys. */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface CachedFetchOptions {
  cacheDir: string;
  ttlMs: number;
  init?: RequestInit;
  /** Override fetch (for testing). */
  fetcher?: (url: string | URL, init?: RequestInit) => Promise<Response>;
}

/**
 * GET (or POST) a URL and cache the JSON body to disk for `ttlMs`.
 * Cache writes are best-effort — failures don't propagate.
 */
export async function cachedJsonFetch(
  url: string,
  opts: CachedFetchOptions,
): Promise<{ body: unknown; fromCache: boolean }> {
  const method = opts.init?.method ?? "GET";
  const bodyKey = typeof opts.init?.body === "string" ? opts.init.body : "";
  // Use JSON.stringify of a tuple so that ambiguous separators in the URL or
  // body cannot collide across different (method, url, body) combinations.
  const key = await sha256Hex(JSON.stringify([method, url, bodyKey]));
  const path = `${opts.cacheDir}/${key}.json`;
  const useCache = opts.ttlMs > 0;

  if (useCache) {
    try {
      const raw = await Deno.readTextFile(path);
      const parsed = JSON.parse(raw) as { fetchedAt: number; body: unknown };
      if (Date.now() - parsed.fetchedAt < opts.ttlMs) {
        return { body: parsed.body, fromCache: true };
      }
    } catch {
      // miss — fall through to network
    }
  }

  const fetchFn = opts.fetcher ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  let resp: Response;
  try {
    resp = await fetchFn(url, { ...opts.init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) {
    throw new Error(
      `Fetch failed: ${method} ${url} -> ${resp.status} ${resp.statusText}`,
    );
  }
  const body = await resp.json();

  if (useCache) {
    try {
      await Deno.mkdir(opts.cacheDir, { recursive: true });
      await Deno.writeTextFile(
        path,
        JSON.stringify({ fetchedAt: Date.now(), body }),
      );
    } catch {
      // cache write failure is non-fatal
    }
  }

  return { body, fromCache: false };
}

/**
 * FNV-1a 32-bit hash, returned as 8-character lowercase hex. Synchronous
 * (unlike sha256Hex) so callers in non-async contexts — like instance-name
 * sanitisation — can use it without restructuring.
 */
export function fnv1a32(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Build a default Deno-style import snippet for an npm package.
 * Star import; agents adjust to named imports as needed.
 */
export function buildSnippet(
  name: string,
  version: string,
  registry: "npm" | "jsr",
): string {
  const safe = name.replace(/[^a-zA-Z0-9_$]/g, "_").replace(/^_+/, "");
  const ident = /^[a-zA-Z_$]/.test(safe) ? safe : `_${safe}`;
  const prefix = registry === "jsr" ? "jsr" : "npm";
  return `import * as ${ident} from "${prefix}:${name}@${version}";`;
}

/**
 * Build a one-line rationale for a candidate. Plain English so it's useful
 * for an agent to relay back to a user.
 */
export function buildRationale(facts: PkgFacts, blockers: string[]): string {
  if (blockers.length > 0) {
    return `Rejected: ${blockers.join(", ")}`;
  }
  const parts: string[] = [];
  if (facts.weeklyDownloads !== null) {
    parts.push(`${formatDownloads(facts.weeklyDownloads)}/week`);
  }
  if (facts.types === "native") parts.push("TS native");
  if (facts.license) parts.push(facts.license);
  if (facts.qualityScore !== null) {
    parts.push(`quality ${facts.qualityScore.toFixed(2)}`);
  }
  if (facts.lastPublish) {
    const months = monthsSince(facts.lastPublish);
    parts.push(months <= 1 ? "recent publish" : `pub ${months}mo ago`);
  }
  return parts.join(", ");
}

function formatDownloads(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * Extract maintainer count from a registry/search package response.
 * `maintainers` may be missing on legacy packages.
 */
export function maintainerCount(
  maintainers: unknown,
): number {
  if (!Array.isArray(maintainers)) return 0;
  return maintainers.filter((m) => m !== null && m !== undefined).length;
}

/**
 * Determine type-availability from a registry manifest's `latest` document.
 */
export function detectTypes(latestManifest: unknown): TypesAvailability {
  if (!latestManifest || typeof latestManifest !== "object") return "none";
  const obj = latestManifest as Record<string, unknown>;
  if (typeof obj.types === "string" && obj.types.length > 0) return "native";
  if (typeof obj.typings === "string" && obj.typings.length > 0) {
    return "native";
  }
  // Some packages declare types via the `exports` map. Best-effort detection:
  const exp = obj.exports;
  if (exp && typeof exp === "object") {
    const stringified = JSON.stringify(exp);
    if (/"types"\s*:/.test(stringified)) return "native";
  }
  return "none";
}

/** Normalise OSV's vulnerability records into our shape. */
export function normaliseVulns(osvBody: unknown): Vuln[] {
  if (!osvBody || typeof osvBody !== "object") return [];
  const vulns = (osvBody as Record<string, unknown>).vulns;
  if (!Array.isArray(vulns)) return [];
  return vulns.map((v) => {
    const obj = v as Record<string, unknown>;
    const id = String(obj.id ?? "OSV-UNKNOWN");
    const sev = extractSeverity(obj);
    return { id, severity: sev };
  });
}

function extractSeverity(vuln: Record<string, unknown>): string {
  const dbSpecific = vuln.database_specific as
    | Record<string, unknown>
    | undefined;
  if (dbSpecific && typeof dbSpecific.severity === "string") {
    return String(dbSpecific.severity).toUpperCase();
  }
  const sevArr = vuln.severity;
  if (Array.isArray(sevArr) && sevArr.length > 0) {
    const first = sevArr[0] as Record<string, unknown>;
    const score = parseCvssScore(String(first.score ?? ""));
    if (score !== null) return cvssToSeverity(score);
  }
  return "UNKNOWN";
}

/**
 * Stopwords stripped from intent before tokenising for search decomposition.
 * Kept tight on purpose: words like "client", "server", "parser" carry signal
 * even when they look generic, so we don't drop them.
 */
const INTENT_STOPWORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

/**
 * Generic suffix words that are useful as query terms (so we still find
 * `*-client` matches) but make poor *filter* terms — canonical packages don't
 * always echo them in name+description (e.g. the `mqtt` package is the
 * canonical MQTT client but its description is "A library for the MQTT
 * protocol"). Stripped from the haystack-match check only.
 */
const INTENT_GENERIC_TERMS: ReadonlySet<string> = new Set([
  "adapter",
  "api",
  "app",
  "application",
  "browser",
  "client",
  "deno",
  "driver",
  "framework",
  "helper",
  "js",
  "kit",
  "lib",
  "library",
  "manager",
  "module",
  "node",
  "package",
  "parser",
  "plugin",
  "provider",
  "sdk",
  "server",
  "service",
  "system",
  "tool",
  "tools",
  "ts",
  "typescript",
  "javascript",
  "util",
  "utilities",
  "utility",
  "web",
]);

/**
 * Split a free-form intent string into lowercase content words. Useful both
 * for query decomposition (running each term as its own search) and for
 * post-filtering loose matches (JSR's tiny index returns lots of generic
 * `*-client` packages for queries like "mqtt client").
 */
export function tokenizeIntent(intent: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of intent.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2) continue;
    if (INTENT_STOPWORDS.has(raw)) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    terms.push(raw);
  }
  return terms;
}

/**
 * Stem to a 4-character prefix so "retry" matches "retrying", "parse" matches
 * "parser", etc. Short terms (<=4 chars like "mqtt") stay exact. English-only
 * heuristic — good enough for package metadata.
 */
function stem(term: string): string {
  return term.length > 4 ? term.slice(0, 4) : term;
}

/**
 * Specific (non-generic) terms used for the haystack-match filter. Generic
 * suffix words like "client", "library", etc. are stripped because canonical
 * packages don't always echo them in their metadata. Falls back to the full
 * tokenisation if every term was generic (e.g. intent="client").
 */
function intentMatchTerms(intent: string): string[] {
  const all = tokenizeIntent(intent);
  const specific = all.filter((t) => !INTENT_GENERIC_TERMS.has(t));
  return specific.length > 0 ? specific : all;
}

/**
 * Predicate: does the candidate match enough "specific" terms from `intent`?
 *
 * For 1-2 specific terms, all must match. For 3+ specific terms, a 2/3
 * majority is enough — package descriptions don't always echo every word in
 * a longer query (e.g. `cron-parser` says "parsing crontab instructions",
 * not "parse cron expressions"). Match is a case-insensitive substring after
 * stemming each term to its first 4 chars; generic suffixes ("client",
 * "library", etc.) are dropped before matching so canonical packages still
 * pass when they don't repeat the suffix.
 */
export function intentMatches(
  intent: string,
  haystack: { name: string; description?: string | null },
): boolean {
  const terms = intentMatchTerms(intent);
  if (terms.length === 0) return true;
  const blob = `${haystack.name} ${haystack.description ?? ""}`.toLowerCase();
  const required = terms.length <= 2 ? terms.length : Math.ceil(
    (terms.length * 2) / 3,
  );
  let hits = 0;
  for (const t of terms) {
    if (blob.includes(stem(t))) hits++;
    if (hits >= required) return true;
  }
  return hits >= required;
}

/**
 * Convert a candidate's facts into a comparable rank score.
 *
 * npm's `/-/v1/search` reports `popularity:1, quality:1, maintenance:1` for
 * almost every result, so its score detail is useless as a discriminator;
 * weekly downloads is the only signal we have left. JSR doesn't publish
 * download counts, so we floor JSR candidates at a level that's competitive
 * with mid-tier npm packages (~10k-30k weekly downloads on the log scale).
 */
export function rankScore(
  facts: PkgFacts,
  runtime: "deno" | "node" | "both",
): number {
  if (facts.registry === "jsr") {
    const baseFromQuality = 3 + (facts.qualityScore ?? 0);
    const denoBoost = runtime !== "node" ? 0.5 : 0;
    return baseFromQuality + denoBoost;
  }
  const dl = facts.weeklyDownloads ?? 0;
  return Math.log10(dl + 1);
}

/**
 * Parse the base score out of a CVSS vector string like
 * `CVSS:3.1/AV:N/...` or a bare numeric score.
 */
export function parseCvssScore(input: string): number | null {
  if (!input) return null;
  const direct = Number(input);
  if (Number.isFinite(direct)) return direct;
  // CVSS vectors don't include the score; OSV usually pairs them with
  // `database_specific.severity`, so we treat unrecognised vectors as null
  // and let the caller fall back to UNKNOWN.
  return null;
}
