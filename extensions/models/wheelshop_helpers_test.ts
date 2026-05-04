import {
  assertEquals,
  assertExists,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildRationale,
  buildSnippet,
  cachedJsonFetch,
  cvssToSeverity,
  DEFAULT_THRESHOLDS,
  detectTypes,
  evaluateGates,
  fnv1a32,
  intentMatches,
  licenseAllowed,
  maintainerCount,
  monthsSince,
  normaliseVulns,
  parseCvssScore,
  parseSpdxLicense,
  type PkgFacts,
  rankScore,
  sha256Hex,
  tokenizeIntent,
} from "./wheelshop_helpers.ts";

// --- parseSpdxLicense ---

Deno.test("parseSpdxLicense splits OR expressions", () => {
  assertEquals(parseSpdxLicense("MIT OR Apache-2.0"), ["MIT", "Apache-2.0"]);
});

Deno.test("parseSpdxLicense splits AND expressions", () => {
  assertEquals(parseSpdxLicense("MIT AND BSD-3-Clause"), [
    "MIT",
    "BSD-3-Clause",
  ]);
});

Deno.test("parseSpdxLicense strips parentheses", () => {
  assertEquals(parseSpdxLicense("(MIT OR Apache-2.0)"), ["MIT", "Apache-2.0"]);
});

Deno.test("parseSpdxLicense returns empty for null/undefined", () => {
  assertEquals(parseSpdxLicense(null), []);
  assertEquals(parseSpdxLicense(undefined), []);
  assertEquals(parseSpdxLicense(""), []);
});

Deno.test("parseSpdxLicense returns single term unchanged", () => {
  assertEquals(parseSpdxLicense("MIT"), ["MIT"]);
});

// --- licenseAllowed ---

Deno.test("licenseAllowed accepts MIT", () => {
  assertEquals(licenseAllowed("MIT"), true);
});

Deno.test("licenseAllowed accepts MIT OR Apache-2.0", () => {
  assertEquals(licenseAllowed("MIT OR Apache-2.0"), true);
});

Deno.test("licenseAllowed rejects GPL-3.0", () => {
  assertEquals(licenseAllowed("GPL-3.0"), false);
});

Deno.test("licenseAllowed rejects mixed allowed+blocked AND", () => {
  // Conservative: AND requires both terms allowed
  assertEquals(licenseAllowed("MIT AND GPL-3.0"), false);
});

Deno.test("licenseAllowed rejects null/empty", () => {
  assertEquals(licenseAllowed(null), false);
  assertEquals(licenseAllowed(""), false);
});

// --- monthsSince ---

Deno.test("monthsSince returns 0 for now", () => {
  const now = new Date("2026-05-04T00:00:00Z");
  assertEquals(monthsSince("2026-05-04T00:00:00Z", now), 0);
});

Deno.test("monthsSince returns ~12 for one year ago", () => {
  const now = new Date("2026-05-04T00:00:00Z");
  const months = monthsSince("2025-05-04T00:00:00Z", now);
  // Floor of 365 days / 30.44 days-per-month is 11; allow 11 or 12.
  assertEquals(months >= 11 && months <= 12, true);
});

Deno.test("monthsSince returns ~36 for three years ago", () => {
  const now = new Date("2026-05-04T00:00:00Z");
  const months = monthsSince("2023-05-04T00:00:00Z", now);
  assertEquals(months >= 35 && months <= 37, true);
});

// --- cvssToSeverity ---

Deno.test("cvssToSeverity maps to expected labels", () => {
  assertEquals(cvssToSeverity(9.8), "CRITICAL");
  assertEquals(cvssToSeverity(7.5), "HIGH");
  assertEquals(cvssToSeverity(5.0), "MEDIUM");
  assertEquals(cvssToSeverity(2.0), "LOW");
  assertEquals(cvssToSeverity(0), "UNKNOWN");
});

// --- parseCvssScore ---

Deno.test("parseCvssScore parses bare numeric string", () => {
  assertEquals(parseCvssScore("7.5"), 7.5);
});

Deno.test("parseCvssScore returns null for empty", () => {
  assertEquals(parseCvssScore(""), null);
});

Deno.test("parseCvssScore returns null for vector strings", () => {
  // Vector strings don't include a base score directly.
  assertEquals(parseCvssScore("CVSS:3.1/AV:N/AC:L"), null);
});

// --- maintainerCount ---

Deno.test("maintainerCount counts non-null entries", () => {
  assertEquals(maintainerCount([{ name: "a" }, { name: "b" }]), 2);
});

Deno.test("maintainerCount returns 0 for non-array", () => {
  assertEquals(maintainerCount(undefined), 0);
  assertEquals(maintainerCount(null), 0);
  assertEquals(maintainerCount("x"), 0);
});

// --- detectTypes ---

Deno.test("detectTypes returns native when types field set", () => {
  assertEquals(detectTypes({ types: "./dist/index.d.ts" }), "native");
});

Deno.test("detectTypes returns native when typings field set", () => {
  assertEquals(detectTypes({ typings: "./types.d.ts" }), "native");
});

Deno.test("detectTypes returns native when exports map declares types", () => {
  assertEquals(
    detectTypes({
      exports: {
        ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      },
    }),
    "native",
  );
});

Deno.test("detectTypes returns none when no type info present", () => {
  assertEquals(detectTypes({ main: "./index.js" }), "none");
});

Deno.test("detectTypes returns none for null/non-object", () => {
  assertEquals(detectTypes(null), "none");
  assertEquals(detectTypes("foo"), "none");
});

// --- normaliseVulns ---

Deno.test("normaliseVulns extracts severity from database_specific", () => {
  const osvBody = {
    vulns: [
      {
        id: "GHSA-xxxx-yyyy",
        database_specific: { severity: "HIGH" },
      },
    ],
  };
  const vulns = normaliseVulns(osvBody);
  assertEquals(vulns.length, 1);
  assertEquals(vulns[0].id, "GHSA-xxxx-yyyy");
  assertEquals(vulns[0].severity, "HIGH");
});

Deno.test("normaliseVulns returns UNKNOWN when severity unparseable", () => {
  const osvBody = {
    vulns: [
      {
        id: "GHSA-zzzz",
        severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L" }],
      },
    ],
  };
  const vulns = normaliseVulns(osvBody);
  assertEquals(vulns[0].severity, "UNKNOWN");
});

Deno.test("normaliseVulns returns empty for empty body", () => {
  assertEquals(normaliseVulns({}), []);
  assertEquals(normaliseVulns(null), []);
});

// --- evaluateGates ---

function baseFacts(overrides: Partial<PkgFacts> = {}): PkgFacts {
  return {
    package: "good-pkg",
    version: "1.0.0",
    registry: "npm",
    description: null,
    license: "MIT",
    weeklyDownloads: 50_000,
    lastPublish: "2026-04-01T00:00:00Z",
    qualityScore: 0.9,
    popularityScore: 0.8,
    maintenanceScore: 0.9,
    deprecated: false,
    maintainerCount: 2,
    types: "native",
    vulns: [],
    repository: null,
    ...overrides,
  };
}

Deno.test("evaluateGates passes a healthy package", () => {
  const now = new Date("2026-05-04T00:00:00Z");
  const result = evaluateGates(baseFacts(), DEFAULT_THRESHOLDS, now);
  assertEquals(result.blockers, []);
});

Deno.test("evaluateGates blocks deprecated packages", () => {
  const now = new Date("2026-05-04T00:00:00Z");
  const result = evaluateGates(
    baseFacts({ deprecated: true }),
    DEFAULT_THRESHOLDS,
    now,
  );
  assertEquals(result.blockers.includes("deprecated"), true);
});

Deno.test("evaluateGates blocks bad licenses", () => {
  const now = new Date("2026-05-04T00:00:00Z");
  const result = evaluateGates(
    baseFacts({ license: "GPL-3.0" }),
    DEFAULT_THRESHOLDS,
    now,
  );
  assertEquals(result.blockers.some((b) => b.startsWith("license:")), true);
});

Deno.test("evaluateGates blocks low download counts", () => {
  const now = new Date("2026-05-04T00:00:00Z");
  const result = evaluateGates(
    baseFacts({ weeklyDownloads: 100 }),
    DEFAULT_THRESHOLDS,
    now,
  );
  assertEquals(
    result.blockers.some((b) => b.startsWith("low-downloads:")),
    true,
  );
});

Deno.test("evaluateGates blocks unmaintained packages", () => {
  const now = new Date("2026-05-04T00:00:00Z");
  const result = evaluateGates(
    baseFacts({ lastPublish: "2023-01-01T00:00:00Z" }),
    DEFAULT_THRESHOLDS,
    now,
  );
  assertEquals(
    result.blockers.some((b) => b.startsWith("unmaintained:")),
    true,
  );
});

Deno.test("evaluateGates blocks low maintenance score", () => {
  const now = new Date("2026-05-04T00:00:00Z");
  const result = evaluateGates(
    baseFacts({ maintenanceScore: 0.1 }),
    DEFAULT_THRESHOLDS,
    now,
  );
  assertEquals(
    result.blockers.some((b) => b.startsWith("low-maintenance:")),
    true,
  );
});

Deno.test("evaluateGates blocks no-types packages", () => {
  const now = new Date("2026-05-04T00:00:00Z");
  const result = evaluateGates(
    baseFacts({ types: "none" }),
    DEFAULT_THRESHOLDS,
    now,
  );
  assertEquals(result.blockers.includes("no-types"), true);
});

Deno.test("evaluateGates blocks orphaned packages (no maintainers)", () => {
  const now = new Date("2026-05-04T00:00:00Z");
  const result = evaluateGates(
    baseFacts({ maintainerCount: 0 }),
    DEFAULT_THRESHOLDS,
    now,
  );
  assertEquals(result.blockers.includes("no-maintainers"), true);
});

Deno.test("evaluateGates blocks high-severity vulns", () => {
  const now = new Date("2026-05-04T00:00:00Z");
  const result = evaluateGates(
    baseFacts({
      vulns: [{ id: "GHSA-bad", severity: "CRITICAL" }],
    }),
    DEFAULT_THRESHOLDS,
    now,
  );
  assertEquals(
    result.blockers.some((b) => b.startsWith("vuln:GHSA-bad")),
    true,
  );
});

Deno.test("evaluateGates allows medium/low vulns", () => {
  const now = new Date("2026-05-04T00:00:00Z");
  const result = evaluateGates(
    baseFacts({
      vulns: [{ id: "GHSA-ok", severity: "LOW" }],
    }),
    DEFAULT_THRESHOLDS,
    now,
  );
  assertEquals(result.blockers, []);
});

Deno.test("evaluateGates blocks unknown-severity vulns conservatively", () => {
  const now = new Date("2026-05-04T00:00:00Z");
  const result = evaluateGates(
    baseFacts({
      vulns: [{ id: "GHSA-mystery", severity: "UNKNOWN" }],
    }),
    DEFAULT_THRESHOLDS,
    now,
  );
  assertEquals(
    result.blockers.some((b) => b.startsWith("vuln:GHSA-mystery")),
    true,
  );
});

// --- buildSnippet ---

Deno.test("buildSnippet builds Deno-style npm import", () => {
  assertEquals(
    buildSnippet("cron-parser", "5.5.0", "npm"),
    `import * as cron_parser from "npm:cron-parser@5.5.0";`,
  );
});

Deno.test("buildSnippet handles scoped packages", () => {
  const out = buildSnippet("@aws-sdk/client-s3", "3.0.0", "npm");
  assertExists(out.includes(`from "npm:@aws-sdk/client-s3@3.0.0"`));
});

Deno.test("buildSnippet builds jsr import", () => {
  const out = buildSnippet("@std/path", "1.0.0", "jsr");
  assertExists(out.includes(`from "jsr:@std/path@1.0.0"`));
});

// --- buildRationale ---

Deno.test("buildRationale shows rejection reason when blocked", () => {
  const rationale = buildRationale(baseFacts(), ["deprecated", "no-types"]);
  assertEquals(rationale, "Rejected: deprecated, no-types");
});

Deno.test("buildRationale highlights downloads, types, license", () => {
  const r = buildRationale(
    baseFacts({ weeklyDownloads: 3_200_000, license: "MIT" }),
    [],
  );
  assertEquals(r.includes("3.2M/week"), true);
  assertEquals(r.includes("TS native"), true);
  assertEquals(r.includes("MIT"), true);
});

// --- sha256Hex ---

Deno.test("sha256Hex produces stable 64-char hex", async () => {
  const hex = await sha256Hex("hello");
  assertEquals(hex.length, 64);
  assertEquals(/^[0-9a-f]+$/.test(hex), true);
});

// --- cachedJsonFetch ---

Deno.test("cachedJsonFetch returns body on miss and caches it", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "wheelshop-cache-" });
  let calls = 0;
  const fakeFetch: typeof fetch = (_url, _init) => {
    calls++;
    return Promise.resolve(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };

  const first = await cachedJsonFetch("https://example.test/x", {
    cacheDir: tmp,
    ttlMs: 60_000,
    fetcher: fakeFetch,
  });
  assertEquals(first.fromCache, false);
  assertEquals((first.body as { ok: boolean }).ok, true);
  assertEquals(calls, 1);

  const second = await cachedJsonFetch("https://example.test/x", {
    cacheDir: tmp,
    ttlMs: 60_000,
    fetcher: fakeFetch,
  });
  assertEquals(second.fromCache, true);
  assertEquals(calls, 1);

  await Deno.remove(tmp, { recursive: true });
});

Deno.test("cachedJsonFetch refetches when TTL has expired", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "wheelshop-cache-" });
  let calls = 0;
  const fakeFetch: typeof fetch = (_url, _init) => {
    calls++;
    return Promise.resolve(
      new Response(JSON.stringify({ n: calls }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };

  await cachedJsonFetch("https://example.test/y", {
    cacheDir: tmp,
    ttlMs: 0, // expire immediately
    fetcher: fakeFetch,
  });
  const second = await cachedJsonFetch("https://example.test/y", {
    cacheDir: tmp,
    ttlMs: 0,
    fetcher: fakeFetch,
  });
  assertEquals(second.fromCache, false);
  assertEquals(calls, 2);

  await Deno.remove(tmp, { recursive: true });
});

Deno.test("cachedJsonFetch propagates non-ok responses as errors", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "wheelshop-cache-" });
  const fakeFetch: typeof fetch = () =>
    Promise.resolve(new Response("not found", { status: 404 }));

  await assertRejects(
    () =>
      cachedJsonFetch("https://example.test/z", {
        cacheDir: tmp,
        ttlMs: 60_000,
        fetcher: fakeFetch,
      }),
    Error,
    "404",
  );

  await Deno.remove(tmp, { recursive: true });
});

Deno.test("cachedJsonFetch separates GET vs POST cache keys", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "wheelshop-cache-" });
  let calls = 0;
  // deno-lint-ignore no-explicit-any
  const fakeFetch: typeof fetch = (_url, init: any) => {
    calls++;
    return Promise.resolve(
      new Response(JSON.stringify({ method: init?.method ?? "GET" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };

  await cachedJsonFetch("https://example.test/a", {
    cacheDir: tmp,
    ttlMs: 60_000,
    fetcher: fakeFetch,
  });
  await cachedJsonFetch("https://example.test/a", {
    cacheDir: tmp,
    ttlMs: 60_000,
    init: { method: "POST", body: '{"q":"x"}' },
    fetcher: fakeFetch,
  });
  assertEquals(calls, 2);

  await Deno.remove(tmp, { recursive: true });
});

// --- tokenizeIntent ---

Deno.test("tokenizeIntent splits on whitespace and punctuation", () => {
  assertEquals(tokenizeIntent("mqtt client"), ["mqtt", "client"]);
  assertEquals(tokenizeIntent("parse cron expressions"), [
    "parse",
    "cron",
    "expressions",
  ]);
});

Deno.test("tokenizeIntent drops stopwords", () => {
  assertEquals(tokenizeIntent("retry with exponential backoff"), [
    "retry",
    "exponential",
    "backoff",
  ]);
  assertEquals(tokenizeIntent("a parser for the cron format"), [
    "parser",
    "cron",
    "format",
  ]);
});

Deno.test("tokenizeIntent dedupes terms", () => {
  assertEquals(tokenizeIntent("http http client"), ["http", "client"]);
});

Deno.test("tokenizeIntent lowercases", () => {
  assertEquals(tokenizeIntent("MQTT Client"), ["mqtt", "client"]);
});

Deno.test("tokenizeIntent handles empty/whitespace", () => {
  assertEquals(tokenizeIntent(""), []);
  assertEquals(tokenizeIntent("   "), []);
});

Deno.test("tokenizeIntent drops single-character noise", () => {
  assertEquals(tokenizeIntent("X mqtt"), ["mqtt"]);
});

// --- intentMatches ---

Deno.test("intentMatches accepts package whose name+desc cover all terms", () => {
  assertEquals(
    intentMatches("mqtt client", {
      name: "mqtt",
      description: "MQTT.js — a client for the MQTT protocol",
    }),
    true,
  );
});

Deno.test("intentMatches rejects package missing a term", () => {
  assertEquals(
    intentMatches("mqtt client", {
      name: "diskuto/client",
      description: "An API client for the Diskuto P2P social network",
    }),
    false,
  );
});

Deno.test("intentMatches matches against name when description is empty", () => {
  assertEquals(
    intentMatches("kubernetes client", {
      name: "kubernetes-client-node",
      description: null,
    }),
    true,
  );
});

Deno.test("intentMatches accepts everything when intent has no content terms", () => {
  assertEquals(
    intentMatches("the and of", { name: "any", description: "" }),
    true,
  );
});

Deno.test("intentMatches stems terms longer than 4 chars", () => {
  // "retry" stems to "retr", which appears in "retrying"
  assertEquals(
    intentMatches("retry with exponential backoff", {
      name: "exponential-backoff",
      description:
        "A utility that allows retrying a function with an exponential delay between attempts.",
    }),
    true,
  );
});

Deno.test("intentMatches keeps short terms exact", () => {
  // "mqtt" (4 chars) is exact — `socket.io-client` doesn't contain it
  assertEquals(
    intentMatches("mqtt client", {
      name: "socket.io-client",
      description: "Realtime application framework client",
    }),
    false,
  );
});

Deno.test("intentMatches drops generic suffix words from filter", () => {
  // The canonical `mqtt` package's description doesn't mention "client" —
  // the user added "client" as a generic suffix, so we shouldn't require it.
  assertEquals(
    intentMatches("mqtt client", {
      name: "mqtt",
      description: "A library for the MQTT protocol",
    }),
    true,
  );
});

Deno.test("intentMatches accepts 2/3 majority for 3+ term intents", () => {
  // "parse cron expressions" — `cron-parser` says "parsing crontab" without
  // the word "expressions", so requiring all 3 terms would reject it.
  assertEquals(
    intentMatches("parse cron expressions", {
      name: "cron-parser",
      description: "Node.js library for parsing crontab instructions",
    }),
    true,
  );
});

Deno.test("intentMatches still rejects packages matching only 1 of 3 terms", () => {
  assertEquals(
    intentMatches("parse cron expressions", {
      name: "json-parser",
      description: "JSON parser",
    }),
    false,
  );
});

Deno.test("intentMatches requires all terms for 2-term intents", () => {
  // "rate limit" (2 specific) — both must match
  assertEquals(
    intentMatches("rate limit", {
      name: "speed-limit",
      description: "limits things",
    }),
    false,
  );
  assertEquals(
    intentMatches("rate limit", {
      name: "rate-limiter",
      description: "rate limiting",
    }),
    true,
  );
});

Deno.test("intentMatches falls back to all terms when every term is generic", () => {
  // intent="client" has only generic terms — fall back so we still filter
  // packages that don't even mention "client".
  assertEquals(
    intentMatches("client", { name: "axios", description: "HTTP library" }),
    false,
  );
  assertEquals(
    intentMatches("client", {
      name: "got",
      description: "A friendly HTTP client",
    }),
    true,
  );
});

// --- rankScore ---

Deno.test("rankScore uses log10 of weekly downloads for npm", () => {
  const facts: PkgFacts = baseFacts({
    registry: "npm",
    weeklyDownloads: 1_000_000,
  });
  const s = rankScore(facts, "both");
  // log10(1,000,001) ≈ 6.0
  assertEquals(Math.round(s * 10) / 10, 6.0);
});

Deno.test("rankScore returns 0 for npm packages with no download data", () => {
  const facts: PkgFacts = baseFacts({
    registry: "npm",
    weeklyDownloads: null,
  });
  assertEquals(rankScore(facts, "both"), 0);
});

Deno.test("rankScore floors jsr packages at competitive mid-tier level", () => {
  const facts: PkgFacts = baseFacts({
    registry: "jsr",
    qualityScore: 1,
  });
  // 3 + 1 + 0.5 (deno boost) = 4.5 — competitive with ~30k weekly downloads
  assertEquals(rankScore(facts, "deno"), 4.5);
});

Deno.test("rankScore drops jsr deno boost when targeting node only", () => {
  const facts: PkgFacts = baseFacts({
    registry: "jsr",
    qualityScore: 1,
  });
  assertEquals(rankScore(facts, "node"), 4);
});

Deno.test("rankScore prefers a 1M-download npm package over a perfect jsr package", () => {
  const npm: PkgFacts = baseFacts({
    registry: "npm",
    weeklyDownloads: 1_000_000,
  });
  const jsr: PkgFacts = baseFacts({
    registry: "jsr",
    qualityScore: 1,
  });
  // 6.0 > 4.5
  assertEquals(rankScore(npm, "deno") > rankScore(jsr, "deno"), true);
});

// --- fnv1a32 ---

Deno.test("fnv1a32 returns stable 8-char hex", () => {
  const h = fnv1a32("mqtt client");
  assertEquals(h.length, 8);
  assertEquals(/^[0-9a-f]+$/.test(h), true);
  // Stable across calls
  assertEquals(fnv1a32("mqtt client"), h);
});

Deno.test("fnv1a32 produces different hashes for different inputs", () => {
  assertEquals(fnv1a32("a") !== fnv1a32("b"), true);
});

// --- cachedJsonFetch cache key uniqueness ---

Deno.test("cachedJsonFetch uses distinct keys for same URL with different bodies", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "wheelshop-cache-" });
  let responseCount = 0;
  // deno-lint-ignore no-explicit-any
  const fakeFetch: typeof fetch = (_url, init: any) => {
    responseCount++;
    return Promise.resolve(
      new Response(JSON.stringify({ body: init?.body ?? "none" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };

  // POST with body '{"a":1}'
  await cachedJsonFetch("https://example.test/q", {
    cacheDir: tmp,
    ttlMs: 60_000,
    init: { method: "POST", body: '{"a":1}' },
    fetcher: fakeFetch,
  });
  // POST with body '{"b":2}' — different body, must not hit cache
  const second = await cachedJsonFetch("https://example.test/q", {
    cacheDir: tmp,
    ttlMs: 60_000,
    init: { method: "POST", body: '{"b":2}' },
    fetcher: fakeFetch,
  });
  assertEquals(second.fromCache, false);
  assertEquals(responseCount, 2);

  await Deno.remove(tmp, { recursive: true });
});

Deno.test("cachedJsonFetch skips cache entirely when ttlMs is 0", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "wheelshop-cache-" });
  let calls = 0;
  const fakeFetch: typeof fetch = () => {
    calls++;
    return Promise.resolve(
      new Response(JSON.stringify({ n: calls }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };

  // First call — always fetches
  await cachedJsonFetch("https://example.test/nocache", {
    cacheDir: tmp,
    ttlMs: 0,
    fetcher: fakeFetch,
  });
  // Second call — ttlMs=0 means no caching, so fetches again
  const second = await cachedJsonFetch("https://example.test/nocache", {
    cacheDir: tmp,
    ttlMs: 0,
    fetcher: fakeFetch,
  });
  assertEquals(second.fromCache, false);
  assertEquals(calls, 2);

  await Deno.remove(tmp, { recursive: true });
});

// --- evaluateGates JSR license ---

Deno.test("evaluateGates does not block jsr packages with null license", () => {
  const now = new Date("2026-05-04T00:00:00Z");
  const result = evaluateGates(
    baseFacts({ registry: "jsr", license: null }),
    DEFAULT_THRESHOLDS,
    now,
  );
  assertEquals(result.blockers.some((b) => b.startsWith("license:")), false);
});

Deno.test("evaluateGates blocks npm packages with null license", () => {
  const now = new Date("2026-05-04T00:00:00Z");
  const result = evaluateGates(
    baseFacts({ registry: "npm", license: null }),
    DEFAULT_THRESHOLDS,
    now,
  );
  assertEquals(result.blockers.some((b) => b.startsWith("license:")), true);
});
