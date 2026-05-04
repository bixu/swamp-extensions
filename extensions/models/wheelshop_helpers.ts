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

  if (!licenseAllowed(facts.license)) {
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
  fetcher?: typeof fetch;
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
  const key = await sha256Hex(`${method}:${url}:${bodyKey}`);
  const path = `${opts.cacheDir}/${key}.json`;

  try {
    const raw = await Deno.readTextFile(path);
    const parsed = JSON.parse(raw) as { fetchedAt: number; body: unknown };
    if (Date.now() - parsed.fetchedAt < opts.ttlMs) {
      return { body: parsed.body, fromCache: true };
    }
  } catch {
    // miss — fall through to network
  }

  const fetchFn = opts.fetcher ?? fetch;
  const resp = await fetchFn(url, opts.init);
  if (!resp.ok) {
    throw new Error(
      `Fetch failed: ${method} ${url} -> ${resp.status} ${resp.statusText}`,
    );
  }
  const body = await resp.json();

  try {
    await Deno.mkdir(opts.cacheDir, { recursive: true });
    await Deno.writeTextFile(
      path,
      JSON.stringify({ fetchedAt: Date.now(), body }),
    );
  } catch {
    // cache write failure is non-fatal
  }

  return { body, fromCache: false };
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
 * Extract maintainer count from a npms.io package response.
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
