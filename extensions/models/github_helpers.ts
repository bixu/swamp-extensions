import { Octokit } from "npm:@octokit/rest@22.0.1";

export function createClient(token: string): Octokit {
  return new Octokit({ auth: token });
}

// deno-lint-ignore no-explicit-any
export function normalizeRepo(r: any): Record<string, unknown> {
  return {
    id: r.id,
    name: r.name,
    fullName: r.full_name,
    visibility: r.visibility ?? (r.private ? "private" : "public"),
    defaultBranch: r.default_branch,
    archived: r.archived ?? false,
    disabled: r.disabled ?? false,
    fork: r.fork ?? false,
    description: r.description ?? null,
    language: r.language ?? null,
    license: r.license?.spdx_id ?? null,
    topics: r.topics ?? [],
    openIssuesCount: r.open_issues_count ?? 0,
    stargazersCount: r.stargazers_count ?? 0,
    forksCount: r.forks_count ?? 0,
    createdAt: r.created_at ?? null,
    updatedAt: r.updated_at ?? null,
    pushedAt: r.pushed_at ?? null,
    htmlUrl: r.html_url,
    hasVulnerabilityAlerts: r._hasVulnerabilityAlerts ?? null,
    secretScanningEnabled:
      r.security_and_analysis?.secret_scanning?.status === "enabled",
    secretScanningPushProtection:
      r.security_and_analysis?.secret_scanning_push_protection?.status ===
        "enabled",
    dependabotSecurityUpdates:
      r.security_and_analysis?.dependabot_security_updates?.status ===
        "enabled",
  };
}

// deno-lint-ignore no-explicit-any
export function normalizeIssue(i: any): Record<string, unknown> {
  return {
    id: i.id,
    number: i.number,
    title: i.title,
    state: i.state,
    stateReason: i.state_reason ?? null,
    user: i.user?.login ?? null,
    labels: (i.labels ?? []).map(
      // deno-lint-ignore no-explicit-any
      (l: any) => (typeof l === "string" ? l : l.name),
    ),
    assignees: (i.assignees ?? []).map(
      // deno-lint-ignore no-explicit-any
      (a: any) => a.login,
    ),
    milestone: i.milestone?.title ?? null,
    body: i.body ?? null,
    isPullRequest: i.pull_request != null,
    createdAt: i.created_at,
    updatedAt: i.updated_at,
    closedAt: i.closed_at ?? null,
    htmlUrl: i.html_url,
  };
}

// deno-lint-ignore no-explicit-any
export function normalizePull(p: any): Record<string, unknown> {
  return {
    id: p.id,
    number: p.number,
    title: p.title,
    state: p.state,
    draft: p.draft ?? false,
    user: p.user?.login ?? null,
    head: p.head?.ref ?? null,
    base: p.base?.ref ?? null,
    labels: (p.labels ?? []).map(
      // deno-lint-ignore no-explicit-any
      (l: any) => (typeof l === "string" ? l : l.name),
    ),
    assignees: (p.assignees ?? []).map(
      // deno-lint-ignore no-explicit-any
      (a: any) => a.login,
    ),
    reviewers: (p.requested_reviewers ?? []).map(
      // deno-lint-ignore no-explicit-any
      (r: any) => r.login,
    ),
    mergeable: p.mergeable ?? null,
    merged: p.merged ?? false,
    mergedBy: p.merged_by?.login ?? null,
    additions: p.additions ?? null,
    deletions: p.deletions ?? null,
    changedFiles: p.changed_files ?? null,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    closedAt: p.closed_at ?? null,
    mergedAt: p.merged_at ?? null,
    htmlUrl: p.html_url,
  };
}

// deno-lint-ignore no-explicit-any
export function normalizeMember(m: any): Record<string, unknown> {
  return {
    id: m.id,
    login: m.login,
    role: m.role ?? null,
    type: m.type ?? "User",
    siteAdmin: m.site_admin ?? false,
    htmlUrl: m.html_url,
  };
}

export function buildIssueSearchQuery(
  query: string,
  opts: {
    owner?: string;
    repo?: string;
    globalOwner?: string;
    globalOrg?: string;
    state?: string;
  },
): string {
  let q = query;
  const owner = opts.owner ?? opts.globalOwner ?? opts.globalOrg;
  if (owner && opts.repo) {
    q += ` repo:${owner}/${opts.repo}`;
  } else if (owner) {
    q += ` org:${owner}`;
  }
  if (opts.state && opts.state !== "all") {
    q += ` state:${opts.state}`;
  }
  q += " is:issue";
  return q;
}

export function requireForce(action: string, target: string, force: boolean) {
  if (!force) {
    throw new Error(
      `"${action}" on "${target}" is irreversible. Pass force: true to proceed.`,
    );
  }
}

export function buildRepoTable(
  // deno-lint-ignore no-explicit-any
  repos: any[],
): string[] {
  const lines: string[] = [];
  const hdr = [
    "Repository".padEnd(40),
    "Vis".padEnd(9),
    "Lang".padEnd(12),
    "Stars".padEnd(6),
    "Issues".padEnd(7),
  ].join(" ");
  lines.push(hdr);
  lines.push("-".repeat(hdr.length));

  for (const r of repos) {
    lines.push([
      String(r.name ?? "").padEnd(40).slice(0, 40),
      String(r.visibility ?? "").padEnd(9).slice(0, 9),
      String(r.language ?? "").padEnd(12).slice(0, 12),
      String(r.stargazersCount ?? 0).padEnd(6),
      String(r.openIssuesCount ?? 0).padEnd(7),
    ].join(" "));
  }

  return lines;
}
