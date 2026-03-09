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
  reposMissingFeatures: Array<RepoSecurityStatus>;
}

export interface RepoSecurityStatus {
  name: string;
  visibility: string;
  secretScanningEnabled: boolean;
  secretScanningPushProtection: boolean;
  dependabotSecurityUpdates: boolean;
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
  };
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
  return repos
    .filter((r) => !r.archived && !r.disabled && !r.fork)
    .map(normalizeSecurityFields);
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
  return repos
    .filter((r) => !r.archived && !r.disabled && !r.fork)
    .map(normalizeSecurityFields);
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
    reposMissingFeatures: missing,
  };
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
  lines.push("=== Security Features (active owned repos) ===");
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

  const missing = summary.reposMissingFeatures;
  if (missing.length > 0) {
    lines.push("");
    lines.push("=== Repos Missing Security Features ===");
    lines.push("");
    const hdr = [
      "Repository".padEnd(35),
      "Vis".padEnd(9),
      "SecScan".padEnd(9),
      "PushProt".padEnd(9),
      "Depbot".padEnd(7),
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
      ].join(" "));
    }
  }

  return lines;
}
