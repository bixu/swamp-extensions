import {
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildOutput,
  type CandidateResult,
  compareCandidates,
  extractLicense,
  extractRepo,
  sanitiseInstanceName,
} from "./wheelshop.ts";
import type { PkgFacts } from "./wheelshop_helpers.ts";

function baseFacts(overrides: Partial<PkgFacts> = {}): PkgFacts {
  return {
    package: "test-pkg",
    version: "1.0.0",
    registry: "npm",
    description: null,
    license: "MIT",
    weeklyDownloads: 1_000_000,
    lastPublish: new Date().toISOString(),
    qualityScore: null,
    popularityScore: null,
    maintenanceScore: null,
    deprecated: false,
    maintainerCount: 1,
    types: "native",
    vulns: [],
    repository: null,
    ...overrides,
  };
}

function candidate(
  overrides:
    & Omit<Partial<CandidateResult>, "facts">
    & { facts?: Partial<PkgFacts> } = {},
): CandidateResult {
  const { facts: factsOverrides, ...rest } = overrides;
  return {
    facts: baseFacts(factsOverrides),
    blockers: [],
    approved: true,
    score: 5,
    ...rest,
  };
}

// --- sanitiseInstanceName ---

Deno.test("sanitiseInstanceName is stable for the same input", () => {
  assertEquals(
    sanitiseInstanceName("p-retry"),
    sanitiseInstanceName("p-retry"),
  );
});

Deno.test("sanitiseInstanceName lowercases and replaces non-alphanumeric runs", () => {
  const out = sanitiseInstanceName("@bixu/Foo Bar.baz");
  // Suffix is a fixed-length hash, so just check the leading slug.
  assertStringIncludes(out, "bixu-foo-bar-baz-");
});

Deno.test("sanitiseInstanceName falls back to 'wheelshop' for empty/all-punct input", () => {
  assertStringIncludes(sanitiseInstanceName("!!!"), "wheelshop-");
  assertStringIncludes(sanitiseInstanceName(""), "wheelshop-");
});

Deno.test("sanitiseInstanceName: summary prefix avoids collision with bare package name", () => {
  // Regression test for the bug fixed in a771c9a: when a single-candidate
  // evaluate run produced an evaluationSummary, both resources derived their
  // instance name from the same package name and collided. The summary path
  // now prefixes with "summary-" so the FNV1a32 suffix differs.
  assertNotEquals(
    sanitiseInstanceName("summary-p-retry"),
    sanitiseInstanceName("p-retry"),
  );
});

// --- compareCandidates ---

Deno.test("compareCandidates: approved beats rejected even with lower score", () => {
  const approved = candidate({ approved: true, score: 1 });
  const rejected = candidate({
    approved: false,
    score: 100,
    facts: { package: "other-pkg" },
  });
  const sorted = [rejected, approved].slice().sort(compareCandidates);
  assertEquals(sorted[0], approved);
  assertEquals(sorted[1], rejected);
});

Deno.test("compareCandidates: among approved, higher score wins", () => {
  const lo = candidate({ approved: true, score: 3, facts: { package: "lo" } });
  const hi = candidate({ approved: true, score: 7, facts: { package: "hi" } });
  const sorted = [lo, hi].slice().sort(compareCandidates);
  assertEquals(sorted[0].facts.package, "hi");
});

Deno.test("compareCandidates: among rejected, higher score wins", () => {
  const lo = candidate({ approved: false, score: 3, facts: { package: "lo" } });
  const hi = candidate({ approved: false, score: 7, facts: { package: "hi" } });
  const sorted = [lo, hi].slice().sort(compareCandidates);
  assertEquals(sorted[0].facts.package, "hi");
});

// --- buildOutput ---

Deno.test("buildOutput: action=ok when at least one candidate is approved", () => {
  const out = buildOutput(
    [
      candidate({ approved: true }),
      candidate({
        approved: false,
        blockers: ["no-types"],
        facts: { package: "other" },
      }),
    ],
    false,
  );
  assertEquals(out.action, "ok");
  assertStringIncludes(out.message, "1 of 2");
});

Deno.test("buildOutput: action=ask_user when zero approvals and unsafe=false", () => {
  const out = buildOutput(
    [candidate({ approved: false, blockers: ["no-types"] })],
    false,
  );
  assertEquals(out.action, "ask_user");
  assertStringIncludes(out.message, "trust gates");
});

Deno.test("buildOutput: action=ok when unsafe=true even with zero approvals", () => {
  const out = buildOutput(
    [candidate({ approved: false, blockers: ["no-types"] })],
    true,
  );
  assertEquals(out.action, "ok");
});

Deno.test("buildOutput: snippet is null for unapproved candidates", () => {
  const out = buildOutput(
    [candidate({ approved: false, blockers: ["no-types"] })],
    false,
  );
  assertEquals(out.candidates[0].snippet, null);
});

Deno.test("buildOutput: snippet uses npm: prefix for approved npm candidates", () => {
  const out = buildOutput(
    [candidate({
      approved: true,
      facts: { package: "p-retry", version: "8.0.0" },
    })],
    false,
  );
  assertStringIncludes(
    out.candidates[0].snippet as string,
    "npm:p-retry@8.0.0",
  );
});

Deno.test("buildOutput: snippet uses jsr: prefix for approved jsr candidates", () => {
  const out = buildOutput(
    [
      candidate({
        approved: true,
        facts: { package: "@std/path", version: "1.1.5", registry: "jsr" },
      }),
    ],
    false,
  );
  assertStringIncludes(
    out.candidates[0].snippet as string,
    "jsr:@std/path@1.1.5",
  );
});

Deno.test("buildOutput: candidate fields are pass-through from facts and result", () => {
  const out = buildOutput(
    [
      candidate({
        approved: true,
        score: 5.94,
        blockers: [],
        facts: {
          package: "p-retry",
          version: "8.0.0",
          registry: "npm",
          description: "Retry a promise",
          license: "MIT",
          weeklyDownloads: 1234,
          types: "native",
        },
      }),
    ],
    false,
  );
  const c = out.candidates[0];
  assertEquals(c.package, "p-retry");
  assertEquals(c.version, "8.0.0");
  assertEquals(c.registry, "npm");
  assertEquals(c.description, "Retry a promise");
  assertEquals(c.license, "MIT");
  assertEquals(c.weeklyDownloads, 1234);
  assertEquals(c.types, "native");
  assertEquals(c.approved, true);
  assertEquals(c.score, 5.94);
  assertEquals(c.blockers, []);
});

// --- extractRepo ---

Deno.test("extractRepo: returns null for null manifest", () => {
  assertEquals(extractRepo(null), null);
});

Deno.test("extractRepo: handles object form { url }", () => {
  assertEquals(
    extractRepo({
      version: "1.0.0",
      repository: { url: "git+https://github.com/foo/bar.git" },
    }),
    "git+https://github.com/foo/bar.git",
  );
});

Deno.test("extractRepo: handles bare string form", () => {
  assertEquals(
    extractRepo({ version: "1.0.0", repository: "github:foo/bar" }),
    "github:foo/bar",
  );
});

Deno.test("extractRepo: returns null when repository field is missing", () => {
  assertEquals(extractRepo({ version: "1.0.0" }), null);
});

// --- extractLicense ---

Deno.test("extractLicense: returns null for null manifest", () => {
  assertEquals(extractLicense(null), null);
});

Deno.test("extractLicense: handles bare string form", () => {
  assertEquals(
    extractLicense({ version: "1.0.0", license: "MIT" }),
    "MIT",
  );
});

Deno.test("extractLicense: handles object form { type }", () => {
  assertEquals(
    extractLicense({ version: "1.0.0", license: { type: "Apache-2.0" } }),
    "Apache-2.0",
  );
});

Deno.test("extractLicense: returns null when license field is missing", () => {
  assertEquals(extractLicense({ version: "1.0.0" }), null);
});
