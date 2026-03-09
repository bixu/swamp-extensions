import { assertEquals } from "jsr:@std/assert@1";
import {
  buildSecuritySummary,
  buildSecurityTable,
  isSecurityApp,
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
    codeScanningEnabled: false,
    codeScanningAlertCount: 0,
    securityApps: [],
    securityChecks: [],
    ...overrides,
  };
}

function makeSummary(
  overrides: Partial<SecuritySummary> = {},
): SecuritySummary {
  return {
    totalRepos: 0,
    activeRepos: 0,
    archivedRepos: 0,
    ownedRepos: 0,
    forkedRepos: 0,
    publicRepos: 0,
    privateRepos: 0,
    secretScanningEnabled: 0,
    secretScanningPushProtection: 0,
    dependabotSecurityUpdates: 0,
    codeScanningEnabled: 0,
    totalCodeScanningAlerts: 0,
    reposWithSecurityApps: 0,
    reposWithSecurityChecks: 0,
    securityAppCoverage: {},
    reposMissingFeatures: [],
    ...overrides,
  };
}

function makeRawRepo(
  // deno-lint-ignore no-explicit-any
  overrides: Record<string, any> = {},
  // deno-lint-ignore no-explicit-any
): Record<string, any> {
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

// --- isSecurityApp ---

Deno.test("isSecurityApp matches snyk", () => {
  assertEquals(isSecurityApp("snyk"), true);
  assertEquals(isSecurityApp("Snyk Security"), true);
  assertEquals(isSecurityApp("snyk-bot"), true);
});

Deno.test("isSecurityApp matches codeql", () => {
  assertEquals(isSecurityApp("codeql"), true);
  assertEquals(isSecurityApp("CodeQL"), true);
});

Deno.test("isSecurityApp matches sonarcloud and sonarqube", () => {
  assertEquals(isSecurityApp("sonarcloud"), true);
  assertEquals(isSecurityApp("SonarQube"), true);
});

Deno.test("isSecurityApp matches other security tools", () => {
  assertEquals(isSecurityApp("veracode"), true);
  assertEquals(isSecurityApp("checkmarx"), true);
  assertEquals(isSecurityApp("semgrep"), true);
  assertEquals(isSecurityApp("mend-bolt"), true);
  assertEquals(isSecurityApp("trivy"), true);
  assertEquals(isSecurityApp("grype"), true);
  assertEquals(isSecurityApp("renovate"), true);
  assertEquals(isSecurityApp("fossa"), true);
});

Deno.test("isSecurityApp rejects non-security apps", () => {
  assertEquals(isSecurityApp("github-actions"), false);
  assertEquals(isSecurityApp("codecov"), false);
  assertEquals(isSecurityApp("vercel"), false);
  assertEquals(isSecurityApp("netlify"), false);
});

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

Deno.test("buildSecuritySummary counts code scanning fields", () => {
  const statuses = [
    makeStatus({
      name: "a",
      codeScanningEnabled: true,
      codeScanningAlertCount: 5,
    }),
    makeStatus({
      name: "b",
      codeScanningEnabled: true,
      codeScanningAlertCount: 3,
    }),
    makeStatus({ name: "c" }),
  ];
  const rawRepos = [
    makeRawRepo({ name: "a" }),
    makeRawRepo({ name: "b" }),
    makeRawRepo({ name: "c" }),
  ];

  const result = buildSecuritySummary(statuses, rawRepos);

  assertEquals(result.codeScanningEnabled, 2);
  assertEquals(result.totalCodeScanningAlerts, 8);
});

Deno.test("buildSecuritySummary counts security apps and checks", () => {
  const statuses = [
    makeStatus({
      name: "a",
      securityApps: ["snyk", "codeql"],
      securityChecks: ["snyk"],
    }),
    makeStatus({
      name: "b",
      securityApps: ["snyk"],
      securityChecks: ["snyk"],
    }),
    makeStatus({ name: "c" }),
  ];
  const rawRepos = [
    makeRawRepo({ name: "a" }),
    makeRawRepo({ name: "b" }),
    makeRawRepo({ name: "c" }),
  ];

  const result = buildSecuritySummary(statuses, rawRepos);

  assertEquals(result.reposWithSecurityApps, 2);
  assertEquals(result.reposWithSecurityChecks, 2);
  assertEquals(result.securityAppCoverage["snyk"], 2);
  assertEquals(result.securityAppCoverage["codeql"], 1);
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
  assertEquals(result.codeScanningEnabled, 0);
  assertEquals(result.totalCodeScanningAlerts, 0);
  assertEquals(result.reposWithSecurityApps, 0);
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
  const summary = makeSummary({
    totalRepos: 10,
    activeRepos: 8,
    archivedRepos: 2,
    ownedRepos: 6,
    forkedRepos: 2,
    publicRepos: 5,
    privateRepos: 3,
    secretScanningEnabled: 4,
  });

  const lines = buildSecurityTable(summary);

  assertEquals(lines[0], "=== Security Summary ===");
  assertEquals(lines.some((l) => l.includes("Total repos: 10")), true);
  assertEquals(lines.some((l) => l.includes("4 / 6")), true);
});

Deno.test("buildSecurityTable includes code scanning section", () => {
  const summary = makeSummary({
    ownedRepos: 10,
    codeScanningEnabled: 3,
    totalCodeScanningAlerts: 15,
  });

  const lines = buildSecurityTable(summary);

  assertEquals(
    lines.some((l) => l.includes("Code scanning") && l.includes("3 / 10")),
    true,
  );
  assertEquals(
    lines.some((l) =>
      l.includes("open code scanning alerts") && l.includes("15")
    ),
    true,
  );
});

Deno.test("buildSecurityTable includes third-party tools section", () => {
  const summary = makeSummary({
    ownedRepos: 10,
    reposWithSecurityApps: 5,
    reposWithSecurityChecks: 4,
    securityAppCoverage: { snyk: 5, codeql: 3 },
  });

  const lines = buildSecurityTable(summary);

  assertEquals(
    lines.some((l) => l.includes("Third-Party Security Tools")),
    true,
  );
  assertEquals(
    lines.some((l) => l.includes("security apps") && l.includes("5 / 10")),
    true,
  );
  assertEquals(lines.some((l) => l.includes("snyk: 5 repos")), true);
  assertEquals(lines.some((l) => l.includes("codeql: 3 repos")), true);
});

Deno.test("buildSecurityTable shows apps column in missing repos table", () => {
  const summary = makeSummary({
    totalRepos: 1,
    activeRepos: 1,
    ownedRepos: 1,
    reposMissingFeatures: [
      makeStatus({
        name: "has-snyk",
        securityApps: ["snyk"],
      }),
    ],
  });

  const lines = buildSecurityTable(summary);
  const repoLine = lines.find((l) => l.includes("has-snyk"));

  assertEquals(repoLine !== undefined, true);
  assertEquals(repoLine!.includes("snyk"), true);
});

Deno.test("buildSecurityTable shows dash for repos with no apps", () => {
  const summary = makeSummary({
    totalRepos: 1,
    activeRepos: 1,
    ownedRepos: 1,
    reposMissingFeatures: [
      makeStatus({ name: "no-apps" }),
    ],
  });

  const lines = buildSecurityTable(summary);
  const repoLine = lines.find((l) => l.includes("no-apps"));

  assertEquals(repoLine !== undefined, true);
  assertEquals(repoLine!.includes("-"), true);
});

Deno.test("buildSecurityTable shows missing repos table when repos are missing features", () => {
  const summary = makeSummary({
    totalRepos: 2,
    activeRepos: 2,
    ownedRepos: 2,
    publicRepos: 2,
    secretScanningEnabled: 1,
    reposMissingFeatures: [
      makeStatus({ name: "bad-repo", visibility: "public" }),
      makeStatus({
        name: "also-bad",
        visibility: "private",
        secretScanningEnabled: true,
      }),
    ],
  });

  const lines = buildSecurityTable(summary);

  assertEquals(
    lines.some((l) => l.includes("Repos Missing")),
    true,
  );
  assertEquals(lines.some((l) => l.includes("also-bad")), true);
  assertEquals(lines.some((l) => l.includes("bad-repo")), true);
});

Deno.test("buildSecurityTable sorts missing repos alphabetically", () => {
  const summary = makeSummary({
    totalRepos: 3,
    activeRepos: 3,
    ownedRepos: 3,
    publicRepos: 3,
    reposMissingFeatures: [
      makeStatus({ name: "zebra" }),
      makeStatus({ name: "alpha" }),
      makeStatus({ name: "middle" }),
    ],
  });

  const lines = buildSecurityTable(summary);
  const repoLines = lines.filter((l) =>
    l.includes("alpha") || l.includes("middle") || l.includes("zebra")
  );

  assertEquals(repoLines[0].includes("alpha"), true);
  assertEquals(repoLines[1].includes("middle"), true);
  assertEquals(repoLines[2].includes("zebra"), true);
});

Deno.test("buildSecurityTable does not show missing section when all repos are secure", () => {
  const summary = makeSummary({
    totalRepos: 1,
    activeRepos: 1,
    ownedRepos: 1,
    publicRepos: 1,
    secretScanningEnabled: 1,
    secretScanningPushProtection: 1,
    dependabotSecurityUpdates: 1,
  });

  const lines = buildSecurityTable(summary);

  assertEquals(
    lines.some((l) => l.includes("Repos Missing")),
    false,
  );
});

Deno.test("buildSecurityTable shows yes/NO for feature status", () => {
  const summary = makeSummary({
    totalRepos: 1,
    activeRepos: 1,
    ownedRepos: 1,
    publicRepos: 1,
    reposMissingFeatures: [
      makeStatus({
        name: "mixed",
        secretScanningEnabled: true,
        secretScanningPushProtection: false,
        dependabotSecurityUpdates: false,
      }),
    ],
  });

  const lines = buildSecurityTable(summary);
  const mixedLine = lines.find((l) => l.includes("mixed"));

  assertEquals(mixedLine !== undefined, true);
  assertEquals(mixedLine!.includes("yes"), true);
  assertEquals(mixedLine!.includes("NO"), true);
});

Deno.test("buildSecurityTable sorts app coverage by count descending", () => {
  const summary = makeSummary({
    securityAppCoverage: { codeql: 2, snyk: 10, semgrep: 5 },
  });

  const lines = buildSecurityTable(summary);
  // App coverage lines are indented and match "  <name>: N repos"
  const appLines = lines.filter((l) => /^\s{2}\w+: \d+ repos$/.test(l));
  const appNames = appLines.map((l) => l.trim().split(":")[0]);

  assertEquals(appNames[0], "snyk");
  assertEquals(appNames[1], "semgrep");
  assertEquals(appNames[2], "codeql");
});
