import { assertEquals } from "jsr:@std/assert@1";
import {
  buildSecuritySummary,
  buildSecurityTable,
} from "./github_security_helpers.ts";
import type {
  RepoSecurityStatus,
  SecuritySummary,
} from "./github_security_helpers.ts";

function makeStatus(
  overrides: Partial<RepoSecurityStatus> = {},
): RepoSecurityStatus {
  return {
    name: "repo",
    visibility: "public",
    secretScanningEnabled: false,
    secretScanningPushProtection: false,
    dependabotSecurityUpdates: false,
    ...overrides,
  };
}

// deno-lint-ignore no-explicit-any
function makeRawRepo(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    name: "repo",
    private: false,
    visibility: "public",
    archived: false,
    disabled: false,
    fork: false,
    ...overrides,
  };
}

// --- buildSecuritySummary ---

Deno.test("buildSecuritySummary counts totals correctly", () => {
  const statuses = [
    makeStatus({ name: "a", secretScanningEnabled: true }),
    makeStatus({ name: "b", dependabotSecurityUpdates: true }),
    makeStatus({ name: "c" }),
  ];
  const rawRepos = [
    makeRawRepo({ name: "a" }),
    makeRawRepo({ name: "b" }),
    makeRawRepo({ name: "c" }),
  ];

  const result = buildSecuritySummary(statuses, rawRepos);

  assertEquals(result.totalRepos, 3);
  assertEquals(result.activeRepos, 3);
  assertEquals(result.archivedRepos, 0);
  assertEquals(result.ownedRepos, 3);
  assertEquals(result.forkedRepos, 0);
  assertEquals(result.secretScanningEnabled, 1);
  assertEquals(result.secretScanningPushProtection, 0);
  assertEquals(result.dependabotSecurityUpdates, 1);
  assertEquals(result.reposMissingFeatures.length, 3);
});

Deno.test("buildSecuritySummary excludes archived and disabled from active count", () => {
  const statuses: RepoSecurityStatus[] = [];
  const rawRepos = [
    makeRawRepo({ name: "active" }),
    makeRawRepo({ name: "archived", archived: true }),
    makeRawRepo({ name: "disabled", disabled: true }),
  ];

  const result = buildSecuritySummary(statuses, rawRepos);

  assertEquals(result.totalRepos, 3);
  assertEquals(result.activeRepos, 1);
  assertEquals(result.archivedRepos, 2);
});

Deno.test("buildSecuritySummary counts forks separately", () => {
  const statuses: RepoSecurityStatus[] = [];
  const rawRepos = [
    makeRawRepo({ name: "owned" }),
    makeRawRepo({ name: "forked", fork: true }),
  ];

  const result = buildSecuritySummary(statuses, rawRepos);

  assertEquals(result.ownedRepos, 1);
  assertEquals(result.forkedRepos, 1);
});

Deno.test("buildSecuritySummary counts public vs private", () => {
  const statuses: RepoSecurityStatus[] = [];
  const rawRepos = [
    makeRawRepo({ name: "pub", visibility: "public" }),
    makeRawRepo({ name: "priv", visibility: "private", private: true }),
  ];

  const result = buildSecuritySummary(statuses, rawRepos);

  assertEquals(result.publicRepos, 1);
  assertEquals(result.privateRepos, 1);
});

Deno.test("buildSecuritySummary repo with all features enabled is not missing", () => {
  const statuses = [
    makeStatus({
      name: "secure",
      secretScanningEnabled: true,
      secretScanningPushProtection: true,
      dependabotSecurityUpdates: true,
    }),
  ];
  const rawRepos = [makeRawRepo({ name: "secure" })];

  const result = buildSecuritySummary(statuses, rawRepos);

  assertEquals(result.reposMissingFeatures.length, 0);
});

Deno.test("buildSecuritySummary handles empty inputs", () => {
  const result = buildSecuritySummary([], []);

  assertEquals(result.totalRepos, 0);
  assertEquals(result.activeRepos, 0);
  assertEquals(result.reposMissingFeatures.length, 0);
});

Deno.test("buildSecuritySummary uses private flag when visibility missing", () => {
  const statuses: RepoSecurityStatus[] = [];
  const rawRepos = [
    {
      name: "no-vis",
      private: true,
      archived: false,
      disabled: false,
      fork: false,
    },
  ];

  const result = buildSecuritySummary(statuses, rawRepos);

  assertEquals(result.publicRepos, 0);
  assertEquals(result.privateRepos, 1);
});

// --- buildSecurityTable ---

Deno.test("buildSecurityTable includes summary header", () => {
  const summary: SecuritySummary = {
    totalRepos: 10,
    activeRepos: 8,
    archivedRepos: 2,
    ownedRepos: 6,
    forkedRepos: 2,
    publicRepos: 5,
    privateRepos: 3,
    secretScanningEnabled: 4,
    secretScanningPushProtection: 3,
    dependabotSecurityUpdates: 2,
    reposMissingFeatures: [],
  };

  const lines = buildSecurityTable(summary);

  assertEquals(lines[0], "=== Security Summary ===");
  assertEquals(lines.some((l) => l.includes("Total repos: 10")), true);
  assertEquals(lines.some((l) => l.includes("4 / 6")), true);
});

Deno.test("buildSecurityTable shows missing repos table when repos are missing features", () => {
  const summary: SecuritySummary = {
    totalRepos: 2,
    activeRepos: 2,
    archivedRepos: 0,
    ownedRepos: 2,
    forkedRepos: 0,
    publicRepos: 2,
    privateRepos: 0,
    secretScanningEnabled: 1,
    secretScanningPushProtection: 0,
    dependabotSecurityUpdates: 0,
    reposMissingFeatures: [
      makeStatus({ name: "bad-repo", visibility: "public" }),
      makeStatus({
        name: "also-bad",
        visibility: "private",
        secretScanningEnabled: true,
      }),
    ],
  };

  const lines = buildSecurityTable(summary);

  assertEquals(
    lines.some((l) => l.includes("Repos Missing Security Features")),
    true,
  );
  assertEquals(lines.some((l) => l.includes("also-bad")), true);
  assertEquals(lines.some((l) => l.includes("bad-repo")), true);
});

Deno.test("buildSecurityTable sorts missing repos alphabetically", () => {
  const summary: SecuritySummary = {
    totalRepos: 3,
    activeRepos: 3,
    archivedRepos: 0,
    ownedRepos: 3,
    forkedRepos: 0,
    publicRepos: 3,
    privateRepos: 0,
    secretScanningEnabled: 0,
    secretScanningPushProtection: 0,
    dependabotSecurityUpdates: 0,
    reposMissingFeatures: [
      makeStatus({ name: "zebra" }),
      makeStatus({ name: "alpha" }),
      makeStatus({ name: "middle" }),
    ],
  };

  const lines = buildSecurityTable(summary);
  const repoLines = lines.filter((l) =>
    l.includes("alpha") || l.includes("middle") || l.includes("zebra")
  );

  assertEquals(repoLines[0].includes("alpha"), true);
  assertEquals(repoLines[1].includes("middle"), true);
  assertEquals(repoLines[2].includes("zebra"), true);
});

Deno.test("buildSecurityTable does not show missing section when all repos are secure", () => {
  const summary: SecuritySummary = {
    totalRepos: 1,
    activeRepos: 1,
    archivedRepos: 0,
    ownedRepos: 1,
    forkedRepos: 0,
    publicRepos: 1,
    privateRepos: 0,
    secretScanningEnabled: 1,
    secretScanningPushProtection: 1,
    dependabotSecurityUpdates: 1,
    reposMissingFeatures: [],
  };

  const lines = buildSecurityTable(summary);

  assertEquals(
    lines.some((l) => l.includes("Repos Missing")),
    false,
  );
});

Deno.test("buildSecurityTable shows yes/NO for feature status", () => {
  const summary: SecuritySummary = {
    totalRepos: 1,
    activeRepos: 1,
    archivedRepos: 0,
    ownedRepos: 1,
    forkedRepos: 0,
    publicRepos: 1,
    privateRepos: 0,
    secretScanningEnabled: 0,
    secretScanningPushProtection: 0,
    dependabotSecurityUpdates: 0,
    reposMissingFeatures: [
      makeStatus({
        name: "mixed",
        secretScanningEnabled: true,
        secretScanningPushProtection: false,
        dependabotSecurityUpdates: false,
      }),
    ],
  };

  const lines = buildSecurityTable(summary);
  const mixedLine = lines.find((l) => l.includes("mixed"));

  assertEquals(mixedLine !== undefined, true);
  assertEquals(mixedLine!.includes("yes"), true);
  assertEquals(mixedLine!.includes("NO"), true);
});
