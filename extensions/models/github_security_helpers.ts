import { Octokit } from "npm:@octokit/rest@22.0.1";

export interface SecuritySummary {
  totalRepos: number;
  activeRepos: number;
  archivedRepos: number;
  ownedRepos: number;
  forkedRepos: number;
  publicRepos: number;
  privateRepos: number;
  secretScanningEnabled: number;
  secretScanningPushProtection: number;
  dependabotSecurityUpdates: number;
  codeScanningEnabled: number;
  totalCodeScanningAlerts: number;
  reposWithSecurityApps: number;
  reposWithSecurityChecks: number;
  securityAppCoverage: Record<string, number>;
  reposMissingFeatures: Array<RepoSecurityStatus>;
}

export interface RepoSecurityStatus {
  name: string;
  visibility: string;
  secretScanningEnabled: boolean;
  secretScanningPushProtection: boolean;
  dependabotSecurityUpdates: boolean;
  codeScanningEnabled: boolean;
  codeScanningAlertCount: number;
  securityApps: string[];
  securityChecks: string[];
}

const SECURITY_APP_PATTERNS = [
  "snyk",
  "codeql",
  "sonarcloud",
  "sonarqube",
  "veracode",
  "checkmarx",
  "semgrep",
  "mend",
  "whitesource",
  "dependabot",
  "renovate",
  "fossa",
  "bridgecrew",
  "prisma cloud",
  "trivy",
  "grype",
];

export function isSecurityApp(name: string): boolean {
  const lower = name.toLowerCase();
  return SECURITY_APP_PATTERNS.some((p) => lower.includes(p));
}

async function parallelMap<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency = 10,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, items.length) },
      () => worker(),
    ),
  );
  return results;
}

// deno-lint-ignore no-explicit-any
function normalizeSecurityFields(r: any): RepoSecurityStatus {
  const sa = r.security_and_analysis ?? {};
  return {
    name: r.name,
    visibility: r.visibility ?? (r.private ? "private" : "public"),
    secretScanningEnabled: sa.secret_scanning?.status === "enabled",
    secretScanningPushProtection:
      sa.secret_scanning_push_protection?.status === "enabled",
    dependabotSecurityUpdates:
      sa.dependabot_security_updates?.status === "enabled",
    codeScanningEnabled: false,
    codeScanningAlertCount: 0,
    securityApps: [],
    securityChecks: [],
  };
}

export async function fetchCodeScanningAlerts(
  client: Octokit,
  org: string,
): Promise<Map<string, number>> {
  const alertsByRepo = new Map<string, number>();
  try {
    const alerts = await client.paginate(
      client.rest.codeScanning.listAlertsForOrg,
      { org, per_page: 100, state: "open" },
    );
    // deno-lint-ignore no-explicit-any
    for (const a of alerts as any[]) {
      const repoName = a.repository?.name ?? "unknown";
      alertsByRepo.set(repoName, (alertsByRepo.get(repoName) ?? 0) + 1);
    }
  } catch {
    // Code scanning may not be available or no alerts exist (404)
  }
  return alertsByRepo;
}

export async function fetchCodeScanningAlertsForRepo(
  client: Octokit,
  owner: string,
  repo: string,
): Promise<number> {
  try {
    const alerts = await client.paginate(
      client.rest.codeScanning.listAlertsForRepo,
      { owner, repo, per_page: 100, state: "open" },
    );
    return alerts.length;
  } catch {
    return 0;
  }
}

export async function fetchOrgInstallations(
  client: Octokit,
  org: string,
): Promise<Map<string, Set<string>>> {
  const appsByRepo = new Map<string, Set<string>>();
  try {
    const resp = await client.rest.orgs.listAppInstallations({ org });
    // deno-lint-ignore no-explicit-any
    for (const installation of resp.data.installations as any[]) {
      const appName = installation.app_slug ?? installation.app_id ?? "unknown";
      if (!isSecurityApp(String(appName))) continue;

      try {
        const repoResp = await client.rest.apps
          .listInstallationReposForAuthenticatedUser({
            installation_id: installation.id,
            per_page: 100,
          });
        // deno-lint-ignore no-explicit-any
        for (const repo of repoResp.data.repositories as any[]) {
          const name = repo.name;
          if (!appsByRepo.has(name)) appsByRepo.set(name, new Set());
          appsByRepo.get(name)!.add(String(appName));
        }
      } catch {
        // May not have permission to list repos for this installation
      }
    }
  } catch {
    // May not have permission to list installations
  }
  return appsByRepo;
}

export async function fetchCheckSuitesForRepo(
  client: Octokit,
  owner: string,
  repo: string,
  defaultBranch: string,
): Promise<string[]> {
  try {
    const resp = await client.rest.checks.listSuitesForRef({
      owner,
      repo,
      ref: defaultBranch,
      per_page: 100,
    });
    const securityApps: string[] = [];
    // deno-lint-ignore no-explicit-any
    for (const suite of resp.data.check_suites as any[]) {
      const appName = suite.app?.slug ?? suite.app?.name ?? "";
      if (appName && isSecurityApp(String(appName))) {
        securityApps.push(String(appName));
      }
    }
    return [...new Set(securityApps)];
  } catch {
    return [];
  }
}

// deno-lint-ignore no-explicit-any
function filterActiveRepos(repos: any[]): any[] {
  return repos.filter((r) => !r.archived && !r.disabled && !r.fork);
}

export async function fetchUserRepoSecurity(
  client: Octokit,
  username?: string,
): Promise<RepoSecurityStatus[]> {
  // deno-lint-ignore no-explicit-any
  let repos: any[];
  if (username) {
    repos = await client.paginate(client.rest.repos.listForUser, {
      username,
      per_page: 100,
      type: "owner",
    });
  } else {
    repos = await client.paginate(
      client.rest.repos.listForAuthenticatedUser,
      { per_page: 100, type: "owner" },
    );
  }

  const active = filterActiveRepos(repos);
  const statuses = active.map(normalizeSecurityFields);

  // Enrich with check suites per repo (no org-level code scanning for users)
  const owner = username ??
    (await client.rest.users.getAuthenticated()).data.login;

  await parallelMap(active, async (r, i) => {
    const [alertCount, checks] = await Promise.all([
      fetchCodeScanningAlertsForRepo(client, owner, r.name),
      fetchCheckSuitesForRepo(client, owner, r.name, r.default_branch),
    ]);
    statuses[i].codeScanningAlertCount = alertCount;
    statuses[i].codeScanningEnabled = alertCount > 0;
    statuses[i].securityChecks = checks;
    statuses[i].securityApps = checks;
  });

  return statuses;
}

export async function fetchOrgRepoSecurity(
  client: Octokit,
  org: string,
): Promise<RepoSecurityStatus[]> {
  const repos = await client.paginate(client.rest.repos.listForOrg, {
    org,
    per_page: 100,
    type: "all",
  });

  const active = filterActiveRepos(repos);
  const statuses = active.map(normalizeSecurityFields);

  // Org-level calls in parallel: code scanning alerts + app installations
  const [alertsByRepo, appsByRepo] = await Promise.all([
    fetchCodeScanningAlerts(client, org),
    fetchOrgInstallations(client, org),
  ]);

  for (const status of statuses) {
    const count = alertsByRepo.get(status.name) ?? 0;
    status.codeScanningAlertCount = count;
    status.codeScanningEnabled = alertsByRepo.has(status.name) || count > 0;
    const apps = appsByRepo.get(status.name);
    if (apps) {
      status.securityApps = [...apps];
    }
  }

  // Check suites per repo — parallelized with concurrency limit
  await parallelMap(active, async (r, i) => {
    const checks = await fetchCheckSuitesForRepo(
      client,
      org,
      r.name,
      r.default_branch,
    );
    // Merge with apps from installations (deduplicate)
    const allApps = new Set([...statuses[i].securityApps, ...checks]);
    statuses[i].securityApps = [...allApps];
    statuses[i].securityChecks = checks;
  });

  return statuses;
}

export function buildSecuritySummary(
  allRepoStatuses: RepoSecurityStatus[],
  // deno-lint-ignore no-explicit-any
  rawRepos: any[],
): SecuritySummary {
  const active = rawRepos.filter((r) => !r.archived && !r.disabled);
  const owned = active.filter((r) => !r.fork);
  const pub = active.filter(
    (r) => (r.visibility ?? (r.private ? "private" : "public")) === "public",
  );

  const ss = allRepoStatuses.filter((r) => r.secretScanningEnabled).length;
  const pp = allRepoStatuses.filter((r) => r.secretScanningPushProtection)
    .length;
  const db = allRepoStatuses.filter((r) => r.dependabotSecurityUpdates).length;
  const cs = allRepoStatuses.filter((r) => r.codeScanningEnabled).length;
  const totalAlerts = allRepoStatuses.reduce(
    (sum, r) => sum + r.codeScanningAlertCount,
    0,
  );
  const withApps = allRepoStatuses.filter((r) => r.securityApps.length > 0)
    .length;
  const withChecks = allRepoStatuses.filter(
    (r) => r.securityChecks.length > 0,
  ).length;

  const appCoverage: Record<string, number> = {};
  for (const r of allRepoStatuses) {
    for (const app of r.securityApps) {
      appCoverage[app] = (appCoverage[app] ?? 0) + 1;
    }
  }

  const missing = allRepoStatuses.filter(
    (r) =>
      !r.secretScanningEnabled ||
      !r.secretScanningPushProtection ||
      !r.dependabotSecurityUpdates,
  );

  return {
    totalRepos: rawRepos.length,
    activeRepos: active.length,
    archivedRepos: rawRepos.length - active.length,
    ownedRepos: owned.length,
    forkedRepos: active.length - owned.length,
    publicRepos: pub.length,
    privateRepos: active.length - pub.length,
    secretScanningEnabled: ss,
    secretScanningPushProtection: pp,
    dependabotSecurityUpdates: db,
    codeScanningEnabled: cs,
    totalCodeScanningAlerts: totalAlerts,
    reposWithSecurityApps: withApps,
    reposWithSecurityChecks: withChecks,
    securityAppCoverage: appCoverage,
    reposMissingFeatures: missing,
  };
}

export function buildSecurityMarkdown(summary: SecuritySummary): string[] {
  const lines: string[] = [];
  const o = summary.ownedRepos;

  lines.push("## Security Summary");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("| --- | --- |");
  lines.push(`| Total repos | ${summary.totalRepos} |`);
  lines.push(
    `| Active | ${summary.activeRepos} (${o} owned, ${summary.forkedRepos} forks) |`,
  );
  lines.push(`| Archived | ${summary.archivedRepos} |`);
  lines.push(`| Public | ${summary.publicRepos} |`);
  lines.push(`| Private | ${summary.privateRepos} |`);
  lines.push("");

  lines.push("## GitHub Security Features (active owned repos)");
  lines.push("");
  lines.push("| Feature | Coverage |");
  lines.push("| --- | --- |");
  lines.push(`| Secret scanning | ${summary.secretScanningEnabled} / ${o} |`);
  lines.push(
    `| Secret scanning push protection | ${summary.secretScanningPushProtection} / ${o} |`,
  );
  lines.push(
    `| Dependabot security updates | ${summary.dependabotSecurityUpdates} / ${o} |`,
  );
  lines.push(
    `| Code scanning (alerts present) | ${summary.codeScanningEnabled} / ${o} |`,
  );
  lines.push(
    `| Total open code scanning alerts | ${summary.totalCodeScanningAlerts} |`,
  );
  lines.push("");

  lines.push("## Third-Party Security Tools");
  lines.push("");
  lines.push("| Metric | Coverage |");
  lines.push("| --- | --- |");
  lines.push(
    `| Repos with security apps | ${summary.reposWithSecurityApps} / ${o} |`,
  );
  lines.push(
    `| Repos with security CI checks | ${summary.reposWithSecurityChecks} / ${o} |`,
  );

  const appEntries = Object.entries(summary.securityAppCoverage).sort(
    (a, b) => b[1] - a[1],
  );
  if (appEntries.length > 0) {
    lines.push("");
    lines.push("| App | Repos |");
    lines.push("| --- | --- |");
    for (const [app, count] of appEntries) {
      lines.push(`| ${app} | ${count} |`);
    }
  }

  const missing = summary.reposMissingFeatures;
  if (missing.length > 0) {
    lines.push("");
    lines.push("## Repos Missing GitHub Security Features");
    lines.push("");
    lines.push(
      "| Repository | Visibility | Secret Scanning | Push Protection | Dependabot | Apps |",
    );
    lines.push("| --- | --- | --- | --- | --- | --- |");
    const sorted = [...missing].sort((a, b) => a.name.localeCompare(b.name));
    for (const r of sorted) {
      const ss = r.secretScanningEnabled ? "yes" : "**NO**";
      const pp = r.secretScanningPushProtection ? "yes" : "**NO**";
      const db = r.dependabotSecurityUpdates ? "yes" : "**NO**";
      const apps = r.securityApps.length > 0 ? r.securityApps.join(", ") : "-";
      lines.push(
        `| ${r.name} | ${r.visibility} | ${ss} | ${pp} | ${db} | ${apps} |`,
      );
    }
  }

  return lines;
}

export function buildSecurityTable(summary: SecuritySummary): string[] {
  const lines: string[] = [];

  lines.push("=== Security Summary ===");
  lines.push("");
  lines.push(`Total repos: ${summary.totalRepos}`);
  lines.push(
    `  Active: ${summary.activeRepos} (${summary.ownedRepos} owned, ${summary.forkedRepos} forks)`,
  );
  lines.push(`  Archived: ${summary.archivedRepos}`);
  lines.push(`  Public: ${summary.publicRepos}`);
  lines.push(`  Private: ${summary.privateRepos}`);
  lines.push("");
  lines.push("=== GitHub Security Features (active owned repos) ===");
  lines.push("");
  lines.push(
    `Secret scanning enabled:          ${summary.secretScanningEnabled} / ${summary.ownedRepos}`,
  );
  lines.push(
    `Secret scanning push protection:  ${summary.secretScanningPushProtection} / ${summary.ownedRepos}`,
  );
  lines.push(
    `Dependabot security updates:      ${summary.dependabotSecurityUpdates} / ${summary.ownedRepos}`,
  );
  lines.push(
    `Code scanning (alerts present):   ${summary.codeScanningEnabled} / ${summary.ownedRepos}`,
  );
  lines.push(
    `Total open code scanning alerts:  ${summary.totalCodeScanningAlerts}`,
  );
  lines.push("");
  lines.push("=== Third-Party Security Tools ===");
  lines.push("");
  lines.push(
    `Repos with security apps:         ${summary.reposWithSecurityApps} / ${summary.ownedRepos}`,
  );
  lines.push(
    `Repos with security CI checks:    ${summary.reposWithSecurityChecks} / ${summary.ownedRepos}`,
  );

  const appEntries = Object.entries(summary.securityAppCoverage).sort(
    (a, b) => b[1] - a[1],
  );
  if (appEntries.length > 0) {
    lines.push("");
    for (const [app, count] of appEntries) {
      lines.push(`  ${app}: ${count} repos`);
    }
  }

  const missing = summary.reposMissingFeatures;
  if (missing.length > 0) {
    lines.push("");
    lines.push("=== Repos Missing GitHub Security Features ===");
    lines.push("");
    const hdr = [
      "Repository".padEnd(35),
      "Vis".padEnd(9),
      "SecScan".padEnd(9),
      "PushProt".padEnd(9),
      "Depbot".padEnd(7),
      "Apps".padEnd(20),
    ].join(" ");
    lines.push(hdr);
    lines.push("-".repeat(hdr.length));
    const sorted = [...missing].sort((a, b) => a.name.localeCompare(b.name));
    for (const r of sorted) {
      lines.push([
        r.name.padEnd(35).slice(0, 35),
        r.visibility.padEnd(9).slice(0, 9),
        (r.secretScanningEnabled ? "yes" : "NO").padEnd(9),
        (r.secretScanningPushProtection ? "yes" : "NO").padEnd(9),
        (r.dependabotSecurityUpdates ? "yes" : "NO").padEnd(7),
        (r.securityApps.length > 0 ? r.securityApps.join(",") : "-").padEnd(20)
          .slice(0, 20),
      ].join(" "));
    }
  }

  return lines;
}
