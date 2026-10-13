/**
 * @module
 * Pure helpers for wheelshop's `smoosh` method: the mechanical steps of
 * building a derived extension from parts of community swamp extensions.
 * Copying, headers, retargeting, import rewiring, license notices and the
 * manifest are all decided here; only the plan and any adaptation code are
 * left to the agent.
 */

import { derivedFromLine, type PriorArtSource } from "./wheelshop_helpers.ts";

/** One file to carry over: `from` inside the source, flat `to` in the target. */
export interface SmooshFile {
  from: string;
  to: string;
}

/** The comment line `smoosh` puts at the top of each derived file. */
export function smooshHeader(source: PriorArtSource, from: string): string {
  return `// ${derivedFromLine(source)} (${from}), ${
    source.license ?? "license unknown"
  }.`;
}

/**
 * Replace every quoted or backticked mention of an old model type with its
 * new one (`type: "@john/tailscale-acl"`, doc references in backticks).
 */
export function retarget(
  text: string,
  types: Record<string, string>,
): { text: string; changed: boolean } {
  let out = text;
  for (const [from, to] of Object.entries(types)) {
    for (const q of ['"', "'", "`"]) {
      out = out.split(`${q}${from}${q}`).join(`${q}${to}${q}`);
    }
  }
  return { text: out, changed: out !== text };
}

/** Resolve a relative import specifier against the importing file's path. */
export function resolveRelative(fromFile: string, spec: string): string {
  const parts = fromFile.split("/").slice(0, -1);
  for (const seg of spec.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

/**
 * Point relative imports at the files' new flat names. `fileMap` maps source
 * paths to target names for every file carried over from the same source;
 * imports of files not carried over are returned as `unmapped`.
 */
export function rewireImports(
  text: string,
  from: string,
  fileMap: Record<string, string>,
): { text: string; unmapped: string[] } {
  const unmapped: string[] = [];
  const out = text.replace(
    /(from\s+|import\s*\(\s*)(["'])(\.{1,2}\/[^"']+)\2/g,
    (match, lead: string, q: string, spec: string) => {
      const target = fileMap[resolveRelative(from, spec)];
      if (!target) {
        unmapped.push(spec);
        return match;
      }
      return `${lead}${q}./${target}${q}`;
    },
  );
  return { text: out, unmapped };
}

/** True when a file is a swamp entry point (a model or a model extension). */
export function isEntryPoint(text: string): boolean {
  return /export\s+const\s+(model|extension)\b/.test(text);
}

/** The LICENSE.txt section crediting one source, with its license text. */
export function licenseNotice(
  source: PriorArtSource,
  licenseText: string,
): string {
  const where = source.repository ? `\n(${source.repository})` : "";
  return `\n---\n\nThis extension includes code from ${source.extension}${where}, used under the following license:\n\n${licenseText.trim()}\n`;
}

/** Manifest fields `smoosh` owns; everything else in an existing manifest is kept. */
export interface SmooshManifestInput {
  name: string;
  version: string;
  description: string;
  base: string;
  models: string[];
  additionalFiles: string[];
}

/**
 * Merge `smoosh`'s files and base dependency into a manifest, keeping any
 * fields and list entries already there.
 */
export function mergeManifest(
  existing: Record<string, unknown>,
  input: SmooshManifestInput,
): Record<string, unknown> {
  const union = (key: string, add: string[]) => [
    ...new Set([...((existing[key] as string[] | undefined) ?? []), ...add]),
  ];
  return {
    manifestVersion: 1,
    name: input.name,
    version: input.version,
    description: input.description,
    paths: { base: "manifest" },
    ...existing,
    models: union("models", input.models),
    additionalFiles: union("additionalFiles", input.additionalFiles),
    dependencies: union("dependencies", [input.base]),
  };
}

/** Today's first CalVer version, e.g. `2026.10.13.1`. */
export function calverToday(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getUTCFullYear()}.${pad(now.getUTCMonth() + 1)}.${
    pad(now.getUTCDate())
  }.1`;
}

/** JSON with object keys sorted, so key order does not count as a change. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, v) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
        )
        : v,
  );
}
