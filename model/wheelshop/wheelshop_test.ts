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
  model,
  pulledLicense,
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

// --- attribute ---

Deno.test("attribute writes prior-art.yaml and reports gaps", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    `${dir}/manifest.yaml`,
    'name: "@me/derived"\nadditionalFiles:\n  - LICENSE.txt\n',
  );
  await Deno.writeTextFile(`${dir}/LICENSE.txt`, "MIT\n@john/tailscale\n");
  await Deno.writeTextFile(
    `${dir}/device_client.ts`,
    "// Derived from @john/tailscale@2026.03.02.1\n",
  );
  const written: Record<string, unknown>[] = [];
  const context = {
    logger: { info: () => {} },
    writeResource: (_spec: string, _name: string, data: unknown) => {
      written.push(data as Record<string, unknown>);
      return Promise.resolve({ name: _name });
    },
  };
  const source = {
    extension: "@john/tailscale",
    version: "2026.03.02.1",
    repository: "https://github.com/john/tailscale",
    license: "MIT",
    files: [{ from: "tailscale/device.ts", to: "device_client.ts" }],
  };

  await model.methods.attribute.execute(
    { manifestPath: `${dir}/manifest.yaml`, sources: [source] },
    context,
  );

  const priorArt = await Deno.readTextFile(`${dir}/prior-art.yaml`);
  assertStringIncludes(priorArt, "extension: '@john/tailscale'");
  assertStringIncludes(priorArt, "to: device_client.ts");
  assertEquals(written[0].action, "fix");
  assertEquals(written[0].extension, "@me/derived");
  assertEquals(written[0].blockers, [
    "prior-art-not-shipped (add prior-art.yaml to additionalFiles)",
  ]);
  await Deno.remove(dir, { recursive: true });
});

// --- pulledLicense ---

async function fakePulledRepo(version: string, license: string | null) {
  const repoDir = await Deno.makeTempDir();
  const root = `${repoDir}/.swamp/pulled-extensions/@sntxrr/acl-drift`;
  await Deno.mkdir(`${root}/files`, { recursive: true });
  await Deno.writeTextFile(`${root}/manifest.yaml`, `version: ${version}\n`);
  if (license) await Deno.writeTextFile(`${root}/files/LICENSE.md`, license);
  return repoDir;
}

const PULLED = { extension: "@sntxrr/acl-drift", version: "2026.07.24.2" };
const MIT_TEXT = "MIT License\n\nPermission is hereby granted, free of charge,";

Deno.test("pulledLicense reads the pulled source's LICENSE file", async () => {
  const repoDir = await fakePulledRepo("2026.07.24.2", MIT_TEXT);
  assertEquals(await pulledLicense(repoDir, PULLED), "MIT");
  await Deno.remove(repoDir, { recursive: true });
});

Deno.test("pulledLicense ignores a pulled copy at another version", async () => {
  const repoDir = await fakePulledRepo("2026.08.01.1", MIT_TEXT);
  assertEquals(await pulledLicense(repoDir, PULLED), null);
  await Deno.remove(repoDir, { recursive: true });
});

Deno.test("pulledLicense is null when not pulled or unlicensed", async () => {
  const repoDir = await fakePulledRepo("2026.07.24.2", null);
  assertEquals(await pulledLicense(repoDir, PULLED), null);
  assertEquals(
    await pulledLicense(repoDir, { ...PULLED, extension: "@x/missing" }),
    null,
  );
  await Deno.remove(repoDir, { recursive: true });
});

Deno.test("attribute fills a missing license from the pulled source", async () => {
  const repoDir = await fakePulledRepo("2026.07.24.2", MIT_TEXT);
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    `${dir}/manifest.yaml`,
    'name: "@me/derived"\nadditionalFiles:\n  - prior-art.yaml\n',
  );
  await Deno.writeTextFile(`${dir}/LICENSE.txt`, "MIT\n@sntxrr/acl-drift\n");
  await Deno.writeTextFile(
    `${dir}/drift.ts`,
    "// Derived from @sntxrr/acl-drift@2026.07.24.2\n",
  );
  const written: Record<string, unknown>[] = [];
  await model.methods.attribute.execute(
    {
      manifestPath: `${dir}/manifest.yaml`,
      sources: [{
        ...PULLED,
        repository: null,
        license: null,
        files: [{ from: "drift.ts", to: "drift.ts" }],
      }],
    },
    {
      repoDir,
      logger: { info: () => {} },
      writeResource: (_spec: string, name: string, data: unknown) => {
        written.push(data as Record<string, unknown>);
        return Promise.resolve({ name });
      },
    },
  );
  assertEquals(written[0].action, "ok");
  assertStringIncludes(
    await Deno.readTextFile(`${dir}/prior-art.yaml`),
    "license: MIT",
  );
  await Deno.remove(dir, { recursive: true });
  await Deno.remove(repoDir, { recursive: true });
});
