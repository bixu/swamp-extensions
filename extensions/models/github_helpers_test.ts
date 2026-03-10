import { assertEquals, assertExists, assertThrows } from "jsr:@std/assert@1";
import {
  buildCodeSearchTable,
  buildIssueSearchQuery,
  buildRepoTable,
  createClient,
  normalizeCodeResult,
  normalizeIssue,
  normalizeMember,
  normalizePull,
  normalizeRepo,
  requireForce,
} from "./github_helpers.ts";

Deno.test("normalizeRepo extracts key fields", () => {
  const raw = {
    id: 1,
    name: "my-repo",
    full_name: "org/my-repo",
    private: false,
    visibility: "public",
    default_branch: "main",
    archived: false,
    disabled: false,
    fork: false,
    description: "A test repo",
    language: "TypeScript",
    license: { spdx_id: "MIT" },
    topics: ["test"],
    open_issues_count: 5,
    stargazers_count: 10,
    forks_count: 3,
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-06-01T00:00:00Z",
    pushed_at: "2025-06-01T00:00:00Z",
    html_url: "https://github.com/org/my-repo",
    security_and_analysis: {
      secret_scanning: { status: "enabled" },
      secret_scanning_push_protection: { status: "enabled" },
      dependabot_security_updates: { status: "disabled" },
    },
  };

  const result = normalizeRepo(raw);

  assertEquals(result.name, "my-repo");
  assertEquals(result.fullName, "org/my-repo");
  assertEquals(result.visibility, "public");
  assertEquals(result.defaultBranch, "main");
  assertEquals(result.license, "MIT");
  assertEquals(result.secretScanningEnabled, true);
  assertEquals(result.secretScanningPushProtection, true);
  assertEquals(result.dependabotSecurityUpdates, false);
});

Deno.test("normalizeRepo handles private repo without visibility field", () => {
  const raw = {
    id: 2,
    name: "private-repo",
    full_name: "org/private-repo",
    private: true,
    default_branch: "main",
    html_url: "https://github.com/org/private-repo",
  };

  const result = normalizeRepo(raw);
  assertEquals(result.visibility, "private");
});

Deno.test("normalizeRepo handles missing security_and_analysis", () => {
  const raw = {
    id: 3,
    name: "bare-repo",
    full_name: "org/bare-repo",
    private: false,
    default_branch: "main",
    html_url: "https://github.com/org/bare-repo",
  };

  const result = normalizeRepo(raw);
  assertEquals(result.secretScanningEnabled, false);
  assertEquals(result.secretScanningPushProtection, false);
  assertEquals(result.dependabotSecurityUpdates, false);
});

Deno.test("normalizeIssue extracts key fields", () => {
  const raw = {
    id: 100,
    number: 42,
    title: "Bug report",
    state: "open",
    state_reason: null,
    user: { login: "alice" },
    labels: [{ name: "bug" }, { name: "urgent" }],
    assignees: [{ login: "bob" }],
    milestone: { title: "v1.0" },
    body: "Something is broken",
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-02T00:00:00Z",
    closed_at: null,
    html_url: "https://github.com/org/repo/issues/42",
  };

  const result = normalizeIssue(raw);

  assertEquals(result.number, 42);
  assertEquals(result.title, "Bug report");
  assertEquals(result.state, "open");
  assertEquals(result.user, "alice");
  assertEquals(result.labels, ["bug", "urgent"]);
  assertEquals(result.assignees, ["bob"]);
  assertEquals(result.milestone, "v1.0");
  assertEquals(result.isPullRequest, false);
});

Deno.test("normalizeIssue detects pull request", () => {
  const raw = {
    id: 101,
    number: 43,
    title: "Fix bug",
    state: "open",
    user: { login: "alice" },
    pull_request: { url: "https://api.github.com/repos/org/repo/pulls/43" },
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-02T00:00:00Z",
    html_url: "https://github.com/org/repo/pull/43",
  };

  const result = normalizeIssue(raw);
  assertEquals(result.isPullRequest, true);
});

Deno.test("normalizePull extracts key fields", () => {
  const raw = {
    id: 200,
    number: 10,
    title: "Add feature",
    state: "open",
    draft: true,
    user: { login: "charlie" },
    head: { ref: "feature-branch" },
    base: { ref: "main" },
    labels: [{ name: "enhancement" }],
    assignees: [],
    requested_reviewers: [{ login: "dave" }],
    mergeable: true,
    merged: false,
    additions: 50,
    deletions: 10,
    changed_files: 3,
    created_at: "2025-03-01T00:00:00Z",
    updated_at: "2025-03-02T00:00:00Z",
    closed_at: null,
    merged_at: null,
    html_url: "https://github.com/org/repo/pull/10",
  };

  const result = normalizePull(raw);

  assertEquals(result.number, 10);
  assertEquals(result.draft, true);
  assertEquals(result.head, "feature-branch");
  assertEquals(result.base, "main");
  assertEquals(result.reviewers, ["dave"]);
  assertEquals(result.merged, false);
  assertEquals(result.additions, 50);
});

Deno.test("normalizeMember extracts key fields", () => {
  const raw = {
    id: 300,
    login: "alice",
    role: "admin",
    type: "User",
    site_admin: false,
    html_url: "https://github.com/alice",
  };

  const result = normalizeMember(raw);

  assertEquals(result.login, "alice");
  assertEquals(result.role, "admin");
  assertEquals(result.type, "User");
  assertEquals(result.siteAdmin, false);
});

Deno.test("buildRepoTable produces header and rows", () => {
  const repos = [
    {
      name: "repo-a",
      visibility: "public",
      language: "TypeScript",
      stargazersCount: 5,
      openIssuesCount: 2,
    },
    {
      name: "repo-b",
      visibility: "private",
      language: "Go",
      stargazersCount: 0,
      openIssuesCount: 0,
    },
  ];

  const lines = buildRepoTable(repos);

  assertEquals(lines.length, 4); // header + separator + 2 rows
  assertEquals(lines[0].includes("Repository"), true);
  assertEquals(lines[2].includes("repo-a"), true);
  assertEquals(lines[2].includes("public"), true);
  assertEquals(lines[3].includes("repo-b"), true);
  assertEquals(lines[3].includes("private"), true);
});

// --- createClient ---

Deno.test("createClient returns an Octokit instance", () => {
  const client = createClient("ghp_test_token");
  assertExists(client);
  assertExists(client.rest);
  assertExists(client.rest.repos);
});

// --- normalizeRepo edge cases ---

Deno.test("normalizeRepo handles archived and disabled repos", () => {
  const raw = {
    id: 10,
    name: "old-repo",
    full_name: "org/old-repo",
    private: false,
    default_branch: "master",
    archived: true,
    disabled: true,
    html_url: "https://github.com/org/old-repo",
  };

  const result = normalizeRepo(raw);
  assertEquals(result.archived, true);
  assertEquals(result.disabled, true);
});

Deno.test("normalizeRepo handles fork repos", () => {
  const raw = {
    id: 11,
    name: "forked-repo",
    full_name: "org/forked-repo",
    private: false,
    default_branch: "main",
    fork: true,
    html_url: "https://github.com/org/forked-repo",
  };

  const result = normalizeRepo(raw);
  assertEquals(result.fork, true);
});

Deno.test("normalizeRepo handles null license", () => {
  const raw = {
    id: 12,
    name: "no-license",
    full_name: "org/no-license",
    private: false,
    default_branch: "main",
    license: null,
    html_url: "https://github.com/org/no-license",
  };

  const result = normalizeRepo(raw);
  assertEquals(result.license, null);
});

Deno.test("normalizeRepo handles missing optional fields gracefully", () => {
  const raw = {
    id: 13,
    name: "minimal",
    full_name: "org/minimal",
    default_branch: "main",
    html_url: "https://github.com/org/minimal",
  };

  const result = normalizeRepo(raw);
  assertEquals(result.archived, false);
  assertEquals(result.disabled, false);
  assertEquals(result.fork, false);
  assertEquals(result.description, null);
  assertEquals(result.language, null);
  assertEquals(result.topics, []);
  assertEquals(result.openIssuesCount, 0);
  assertEquals(result.stargazersCount, 0);
  assertEquals(result.forksCount, 0);
  assertEquals(result.createdAt, null);
  assertEquals(result.updatedAt, null);
  assertEquals(result.pushedAt, null);
});

Deno.test("normalizeRepo preserves topics array", () => {
  const raw = {
    id: 14,
    name: "tagged",
    full_name: "org/tagged",
    private: false,
    default_branch: "main",
    topics: ["kubernetes", "devops", "security"],
    html_url: "https://github.com/org/tagged",
  };

  const result = normalizeRepo(raw);
  assertEquals(result.topics, ["kubernetes", "devops", "security"]);
});

Deno.test("normalizeRepo with _hasVulnerabilityAlerts override", () => {
  const raw = {
    id: 15,
    name: "vuln-repo",
    full_name: "org/vuln-repo",
    private: false,
    default_branch: "main",
    _hasVulnerabilityAlerts: true,
    html_url: "https://github.com/org/vuln-repo",
  };

  const result = normalizeRepo(raw);
  assertEquals(result.hasVulnerabilityAlerts, true);
});

// --- normalizeIssue edge cases ---

Deno.test("normalizeIssue handles missing optional fields", () => {
  const raw = {
    id: 110,
    number: 1,
    title: "Minimal issue",
    state: "open",
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
    html_url: "https://github.com/org/repo/issues/1",
  };

  const result = normalizeIssue(raw);
  assertEquals(result.user, null);
  assertEquals(result.labels, []);
  assertEquals(result.assignees, []);
  assertEquals(result.milestone, null);
  assertEquals(result.body, null);
  assertEquals(result.stateReason, null);
  assertEquals(result.closedAt, null);
});

Deno.test("normalizeIssue handles string labels", () => {
  const raw = {
    id: 111,
    number: 2,
    title: "String labels issue",
    state: "open",
    labels: ["bug", "help wanted"],
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
    html_url: "https://github.com/org/repo/issues/2",
  };

  const result = normalizeIssue(raw);
  assertEquals(result.labels, ["bug", "help wanted"]);
});

Deno.test("normalizeIssue handles closed issue with state_reason", () => {
  const raw = {
    id: 112,
    number: 3,
    title: "Completed issue",
    state: "closed",
    state_reason: "completed",
    user: { login: "alice" },
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-05T00:00:00Z",
    closed_at: "2025-01-05T00:00:00Z",
    html_url: "https://github.com/org/repo/issues/3",
  };

  const result = normalizeIssue(raw);
  assertEquals(result.state, "closed");
  assertEquals(result.stateReason, "completed");
  assertEquals(result.closedAt, "2025-01-05T00:00:00Z");
});

// --- normalizePull edge cases ---

Deno.test("normalizePull handles merged pull request", () => {
  const raw = {
    id: 210,
    number: 20,
    title: "Merged PR",
    state: "closed",
    draft: false,
    user: { login: "alice" },
    head: { ref: "feature" },
    base: { ref: "main" },
    merged: true,
    merged_by: { login: "bob" },
    merged_at: "2025-02-01T00:00:00Z",
    closed_at: "2025-02-01T00:00:00Z",
    created_at: "2025-01-15T00:00:00Z",
    updated_at: "2025-02-01T00:00:00Z",
    html_url: "https://github.com/org/repo/pull/20",
  };

  const result = normalizePull(raw);
  assertEquals(result.merged, true);
  assertEquals(result.mergedBy, "bob");
  assertEquals(result.mergedAt, "2025-02-01T00:00:00Z");
});

Deno.test("normalizePull handles missing optional fields", () => {
  const raw = {
    id: 211,
    number: 21,
    title: "Minimal PR",
    state: "open",
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
    html_url: "https://github.com/org/repo/pull/21",
  };

  const result = normalizePull(raw);
  assertEquals(result.draft, false);
  assertEquals(result.user, null);
  assertEquals(result.head, null);
  assertEquals(result.base, null);
  assertEquals(result.labels, []);
  assertEquals(result.assignees, []);
  assertEquals(result.reviewers, []);
  assertEquals(result.mergeable, null);
  assertEquals(result.merged, false);
  assertEquals(result.mergedBy, null);
  assertEquals(result.additions, null);
  assertEquals(result.deletions, null);
  assertEquals(result.changedFiles, null);
  assertEquals(result.closedAt, null);
  assertEquals(result.mergedAt, null);
});

Deno.test("normalizePull handles multiple reviewers and labels", () => {
  const raw = {
    id: 212,
    number: 22,
    title: "Multi-reviewer PR",
    state: "open",
    draft: false,
    user: { login: "dev" },
    head: { ref: "feature-x" },
    base: { ref: "main" },
    labels: [{ name: "review-needed" }, { name: "security" }],
    assignees: [{ login: "alice" }, { login: "bob" }],
    requested_reviewers: [{ login: "charlie" }, { login: "dave" }],
    created_at: "2025-03-01T00:00:00Z",
    updated_at: "2025-03-02T00:00:00Z",
    html_url: "https://github.com/org/repo/pull/22",
  };

  const result = normalizePull(raw);
  assertEquals(result.labels, ["review-needed", "security"]);
  assertEquals(result.assignees, ["alice", "bob"]);
  assertEquals(result.reviewers, ["charlie", "dave"]);
});

// --- normalizeMember edge cases ---

Deno.test("normalizeMember handles missing role", () => {
  const raw = {
    id: 310,
    login: "bot-user",
    type: "Bot",
    site_admin: false,
    html_url: "https://github.com/bot-user",
  };

  const result = normalizeMember(raw);
  assertEquals(result.login, "bot-user");
  assertEquals(result.role, null);
  assertEquals(result.type, "Bot");
});

Deno.test("normalizeMember handles site admin", () => {
  const raw = {
    id: 311,
    login: "admin-user",
    role: "admin",
    type: "User",
    site_admin: true,
    html_url: "https://github.com/admin-user",
  };

  const result = normalizeMember(raw);
  assertEquals(result.siteAdmin, true);
});

Deno.test("normalizeMember handles minimal fields", () => {
  const raw = {
    id: 312,
    login: "minimal-user",
    html_url: "https://github.com/minimal-user",
  };

  const result = normalizeMember(raw);
  assertEquals(result.login, "minimal-user");
  assertEquals(result.role, null);
  assertEquals(result.type, "User");
  assertEquals(result.siteAdmin, false);
});

// --- buildRepoTable edge cases ---

Deno.test("buildRepoTable handles empty repo list", () => {
  const lines = buildRepoTable([]);
  assertEquals(lines.length, 2); // header + separator only
});

Deno.test("buildRepoTable truncates long repo names", () => {
  const repos = [
    {
      name: "a".repeat(60),
      visibility: "public",
      language: "Rust",
      stargazersCount: 1,
      openIssuesCount: 0,
    },
  ];

  const lines = buildRepoTable(repos);
  assertEquals(lines.length, 3);
  // The name column is padEnd(40).slice(0,40), so max 40 chars
  const nameCol = lines[2].slice(0, 40);
  assertEquals(nameCol.length, 40);
});

Deno.test("buildRepoTable handles null language", () => {
  const repos = [
    {
      name: "no-lang",
      visibility: "public",
      language: null,
      stargazersCount: 0,
      openIssuesCount: 0,
    },
  ];

  const lines = buildRepoTable(repos);
  assertEquals(lines.length, 3);
  // Should not throw, null becomes ""
  assertEquals(lines[2].includes("no-lang"), true);
});

// --- requireForce ---

Deno.test("requireForce throws when force is false", () => {
  assertThrows(
    () => requireForce("deleteRepo", "org/my-repo", false),
    Error,
    "irreversible",
  );
});

Deno.test("requireForce does not throw when force is true", () => {
  requireForce("deleteRepo", "org/my-repo", true);
  // No assertion needed — just verifying it doesn't throw
});

Deno.test("requireForce includes action and target in error message", () => {
  try {
    requireForce("deleteRepo", "org/critical-repo", false);
  } catch (e) {
    const msg = (e as Error).message;
    assertEquals(msg.includes("deleteRepo"), true);
    assertEquals(msg.includes("org/critical-repo"), true);
  }
});

// --- buildIssueSearchQuery ---

Deno.test("buildIssueSearchQuery with owner and repo scopes to repo", () => {
  const q = buildIssueSearchQuery("network-helper immutable", {
    owner: "harvester",
    repo: "harvester",
  });
  assertEquals(q, "network-helper immutable repo:harvester/harvester is:issue");
});

Deno.test("buildIssueSearchQuery with owner only scopes to org", () => {
  const q = buildIssueSearchQuery("bug", { owner: "harvester" });
  assertEquals(q, "bug org:harvester is:issue");
});

Deno.test("buildIssueSearchQuery with no owner or repo adds only is:issue", () => {
  const q = buildIssueSearchQuery("global search", {});
  assertEquals(q, "global search is:issue");
});

Deno.test("buildIssueSearchQuery falls back to globalOwner", () => {
  const q = buildIssueSearchQuery("test", {
    globalOwner: "bixu",
    repo: "swamp",
  });
  assertEquals(q, "test repo:bixu/swamp is:issue");
});

Deno.test("buildIssueSearchQuery falls back to globalOrg", () => {
  const q = buildIssueSearchQuery("test", { globalOrg: "myorg" });
  assertEquals(q, "test org:myorg is:issue");
});

Deno.test("buildIssueSearchQuery owner precedence: method > globalOwner > globalOrg", () => {
  const q = buildIssueSearchQuery("test", {
    owner: "explicit",
    globalOwner: "fallback",
    globalOrg: "last-resort",
    repo: "repo",
  });
  assertEquals(q, "test repo:explicit/repo is:issue");
});

Deno.test("buildIssueSearchQuery adds state filter for non-all states", () => {
  const q = buildIssueSearchQuery("bug", {
    owner: "org",
    repo: "repo",
    state: "open",
  });
  assertEquals(q, "bug repo:org/repo state:open is:issue");
});

Deno.test("buildIssueSearchQuery omits state filter for 'all'", () => {
  const q = buildIssueSearchQuery("bug", {
    owner: "org",
    repo: "repo",
    state: "all",
  });
  assertEquals(q, "bug repo:org/repo is:issue");
});

Deno.test("buildIssueSearchQuery with globalOrg but no repo scopes to org", () => {
  const q = buildIssueSearchQuery("search term", {
    globalOrg: "myorg",
    state: "closed",
  });
  assertEquals(q, "search term org:myorg state:closed is:issue");
});

// --- normalizeCodeResult ---

Deno.test("normalizeCodeResult extracts key fields", () => {
  const raw = {
    name: "Jenkinsfile",
    path: "Jenkinsfile",
    sha: "abc123",
    html_url: "https://github.com/org/repo/blob/main/Jenkinsfile",
    repository: { full_name: "org/repo" },
    score: 1.5,
  };

  const result = normalizeCodeResult(raw);
  assertEquals(result.name, "Jenkinsfile");
  assertEquals(result.path, "Jenkinsfile");
  assertEquals(result.repository, "org/repo");
  assertEquals(result.sha, "abc123");
  assertEquals(result.score, 1.5);
  assertEquals(
    result.htmlUrl,
    "https://github.com/org/repo/blob/main/Jenkinsfile",
  );
});

Deno.test("normalizeCodeResult handles missing repository", () => {
  const raw = {
    name: "build.gradle",
    path: "build.gradle",
    sha: "def456",
    html_url: "https://github.com/org/repo/blob/main/build.gradle",
  };

  const result = normalizeCodeResult(raw);
  assertEquals(result.repository, null);
  assertEquals(result.score, null);
});

// --- buildCodeSearchTable ---

Deno.test("buildCodeSearchTable produces header and rows", () => {
  const results = [
    { repository: "org/repo-a", path: "Jenkinsfile" },
    { repository: "org/repo-b", path: "build.gradle.kts" },
  ];

  const lines = buildCodeSearchTable(results);
  assertEquals(lines.length, 4);
  assertEquals(lines[0].includes("Repository"), true);
  assertEquals(lines[2].includes("org/repo-a"), true);
  assertEquals(lines[2].includes("Jenkinsfile"), true);
  assertEquals(lines[3].includes("build.gradle.kts"), true);
});

Deno.test("buildCodeSearchTable handles empty results", () => {
  const lines = buildCodeSearchTable([]);
  assertEquals(lines.length, 2); // header + separator only
});
