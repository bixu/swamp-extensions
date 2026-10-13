// Derived from @sntxrr/tailscale-acl-drift@2026.07.24.2 (models/tailscale_acl_drift.ts), MIT, Copyright (c) 2026 sntxrr.
/**
 * @module
 * HuJSON parsing and semantic policy comparison shared by the `drift` and
 * `propose` methods.
 */

/** A top-level policy section that differs between live and file policy. */
export interface Difference {
  section: string;
  state: "only-live" | "only-file" | "changed";
}

/** Parsed JSON value produced by the HuJSON reader. */
export type Json = null | boolean | number | string | Json[] | {
  [k: string]: Json;
};

/**
 * Strip comments and trailing commas from HuJSON (JWCC) and parse it as JSON.
 *
 * Tailscale policy files are HuJSON: JSON with `//` and comments plus
 * trailing commas. This walks the source character by character so that
 * comment markers and commas appearing inside string literals are preserved
 * rather than mangled.
 *
 * @param source Raw HuJSON text.
 * @returns The parsed policy object.
 */
export function parseHujson(source: string): Json {
  let out = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }

    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      out += "\n";
      continue;
    }

    if (ch === "/" && next === "*") {
      i += 2;
      while (
        i < source.length && !(source[i] === "*" && source[i + 1] === "/")
      ) {
        i++;
      }
      i++;
      continue;
    }

    out += ch;
  }

  return JSON.parse(dropTrailingCommas(out)) as Json;
}

/**
 * Drop commas that precede a closing brace or bracket, outside string
 * literals. Comments must already be stripped.
 */
function dropTrailingCommas(source: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === ",") {
      let j = i + 1;
      while (j < source.length && /\s/.test(source[j])) j++;
      if (source[j] === "}" || source[j] === "]") continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Detect whether HuJSON source contains any comment outside of a string.
 *
 * @param source Raw HuJSON text.
 * @returns True when at least one `//` or comment is present.
 */
export function hasComments(source: string): boolean {
  let inString = false;
  let escaped = false;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "/" && (next === "/" || next === "*")) return true;
  }
  return false;
}

/**
 * Serialize a JSON value with object keys sorted, so that two structurally
 * equal policies compare equal regardless of key ordering.
 *
 * @param value Value to canonicalize.
 * @returns Deterministic string encoding of the value.
 */
export function canonicalize(value: Json): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${
    keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(",")
  }}`;
}

/**
 * Compare live and file policies section by section.
 *
 * @param live Policy currently active on the tailnet.
 * @param file Policy parsed from the GitOps repository.
 * @returns One entry per diverging top-level section.
 */
export function comparePolicies(
  live: Record<string, Json>,
  file: Record<string, Json>,
): Difference[] {
  const sections = new Set([...Object.keys(live), ...Object.keys(file)]);
  const differences: Difference[] = [];

  for (const section of [...sections].sort()) {
    const inLive = section in live;
    const inFile = section in file;

    if (inLive && !inFile) {
      differences.push({ section, state: "only-live" });
    } else if (!inLive && inFile) {
      differences.push({ section, state: "only-file" });
    } else if (canonicalize(live[section]) !== canonicalize(file[section])) {
      differences.push({ section, state: "changed" });
    }
  }

  return differences;
}

/**
 * Parse the live policy snapshot that `@swamp/tailscale/policy-file`'s `get`
 * writes: `{ policy: "<HuJSON text>", etag }`.
 */
export function parseLivePolicy(
  live: Record<string, unknown>,
): Record<string, Json> {
  if (typeof live.policy !== "string") {
    throw new Error(
      "ACL snapshot has no `policy` text. Run the `get` method on this model first.",
    );
  }
  const parsed = parseHujson(live.policy);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Live ACL policy did not parse to an object.");
  }
  return parsed;
}
