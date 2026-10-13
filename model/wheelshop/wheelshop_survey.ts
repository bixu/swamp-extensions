/**
 * @module
 * Pure helpers for wheelshop's `survey` method: rank the community swamp
 * extensions for a domain, pick a base to build on, and show which others
 * are reusable or already covered by that base.
 */

import { licenseAllowed, monthsSince } from "./wheelshop_helpers.ts";

/** The fields `survey` reads from `swamp extension info <name> --json`. */
export interface SwampExtensionInfo {
  name: string;
  latestVersion: string;
  license?: string | null;
  repository?: string | null;
  repositoryVerified?: boolean | null;
  deprecatedAt?: string | null;
  supersededBy?: string | null;
  yankedAt?: string | null;
  updatedAt?: string | null;
  pullCount?: number | null;
  score?: { percentage?: number } | null;
  contentMetadata?: {
    models?: {
      fileName: string;
      type?: string;
      methods?: { name: string }[];
    }[];
  } | null;
}

/** One ranked survey entry. */
export interface SurveyCandidate {
  name: string;
  version: string;
  official: boolean;
  /** Name contains every query word; only relevant extensions can be the base. */
  relevant: boolean;
  repository: string | null;
  license: string | null;
  /** License allows copying code (vs. only depending on the extension). */
  reusable: boolean;
  blockers: string[];
  score: number | null;
  pullCount: number | null;
  updatedAt: string | null;
  /** Methods per model type (file name when the type is not published). */
  methods: Record<string, string[]>;
  /** Share of this extension's method names the base also has; null for the base. */
  overlapWithBase: number | null;
  likelyRedundant: boolean;
}

/** Official extensions are published under the `@swamp` collective. */
export function isOfficial(name: string): boolean {
  return name.startsWith("@swamp/");
}

/** Health gates for depending on or borrowing from an extension. */
export function surveyBlockers(
  info: SwampExtensionInfo,
  now = new Date(),
  maxAgeMonths = 24,
): string[] {
  const blockers: string[] = [];
  if (info.yankedAt) blockers.push("yanked");
  if (info.deprecatedAt) blockers.push("deprecated");
  if (info.supersededBy) blockers.push(`superseded-by:${info.supersededBy}`);
  if (info.updatedAt && monthsSince(info.updatedAt, now) > maxAgeMonths) {
    blockers.push("stale");
  }
  if (!info.repository) blockers.push("no-repository");
  return blockers;
}

/** Method names per model type, from the registry's content metadata. */
export function methodsByType(
  info: SwampExtensionInfo,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const m of info.contentMetadata?.models ?? []) {
    out[m.type || m.fileName] = (m.methods ?? []).map((x) => x.name);
  }
  return out;
}

/**
 * Share of a candidate's distinct method names that the base also offers,
 * or null when the candidate publishes no models (e.g. extensions only).
 */
export function methodOverlap(
  candidate: Record<string, string[]>,
  base: Record<string, string[]>,
): number | null {
  const names = new Set(Object.values(candidate).flat());
  if (names.size === 0) return null;
  const baseNames = new Set(Object.values(base).flat());
  const shared = [...names].filter((n) => baseNames.has(n)).length;
  return Math.round((shared / names.size) * 100) / 100;
}

/** True when the extension name contains every word of the query. */
export function isRelevant(name: string, query: string): boolean {
  const lower = name.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((w) =>
    lower.includes(w)
  );
}

/** Order: relevant, then official, then healthy, then score, pulls, recency. */
export function compareSurvey(a: SurveyCandidate, b: SurveyCandidate): number {
  return Number(b.relevant) - Number(a.relevant) ||
    Number(b.official) - Number(a.official) ||
    a.blockers.length - b.blockers.length ||
    (b.score ?? -1) - (a.score ?? -1) ||
    (b.pullCount ?? -1) - (a.pullCount ?? -1) ||
    (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
}

/** The base to build on: the top-ranked relevant, healthy extension with models. */
export function pickBase(ranked: SurveyCandidate[]): SurveyCandidate | null {
  return ranked.find((c) =>
    c.relevant && c.blockers.length === 0 &&
    Object.keys(c.methods).length > 0
  ) ?? null;
}

/**
 * Turn registry info into ranked candidates, a base, and each candidate's
 * method overlap with that base. `licenses` holds licenses resolved from
 * pulled copies for extensions the registry has none for.
 */
export function buildSurvey(
  query: string,
  infos: SwampExtensionInfo[],
  licenses: Record<string, string | null>,
  now = new Date(),
): { base: string | null; candidates: SurveyCandidate[] } {
  const ranked = infos.map((info): SurveyCandidate => {
    const license = info.license ?? licenses[info.name] ?? null;
    return {
      name: info.name,
      version: info.latestVersion,
      official: isOfficial(info.name),
      relevant: isRelevant(info.name, query),
      repository: info.repository ?? null,
      license,
      reusable: licenseAllowed(license),
      blockers: surveyBlockers(info, now),
      score: info.score?.percentage ?? null,
      pullCount: info.pullCount ?? null,
      updatedAt: info.updatedAt ?? null,
      methods: methodsByType(info),
      overlapWithBase: null,
      likelyRedundant: false,
    };
  }).sort(compareSurvey);
  const base = pickBase(ranked);
  for (const c of ranked) {
    if (!base || c === base) continue;
    c.overlapWithBase = methodOverlap(c.methods, base.methods);
    c.likelyRedundant = c.overlapWithBase === 1;
  }
  return { base: base?.name ?? null, candidates: ranked };
}
