import { z } from "npm:zod@4";
import {
  buildRepoTable,
  createClient,
  normalizeIssue,
  normalizeMember,
  normalizePull,
  normalizeRepo,
} from "./github_helpers.ts";

const GlobalArgsSchema = z.object({
  token: z.string().describe("GitHub personal access token"),
  org: z.string().optional().describe(
    "Default GitHub organization (can be overridden per method)",
  ),
  owner: z.string().optional().describe(
    "Default repository owner for repo-scoped methods",
  ),
});

const RepoSchema = z.object({
  id: z.number(),
  name: z.string(),
  fullName: z.string(),
  visibility: z.string(),
  defaultBranch: z.string(),
  archived: z.boolean(),
  disabled: z.boolean(),
  fork: z.boolean(),
  description: z.string().nullable(),
  language: z.string().nullable(),
  license: z.string().nullable(),
  topics: z.array(z.string()),
  openIssuesCount: z.number(),
  stargazersCount: z.number(),
  forksCount: z.number(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  pushedAt: z.string().nullable(),
  htmlUrl: z.string(),
  hasVulnerabilityAlerts: z.boolean().nullable(),
  secretScanningEnabled: z.boolean(),
  secretScanningPushProtection: z.boolean(),
  dependabotSecurityUpdates: z.boolean(),
}).passthrough();

const IssueSchema = z.object({
  id: z.number(),
  number: z.number(),
  title: z.string(),
  state: z.string(),
  user: z.string().nullable(),
  labels: z.array(z.string()),
  createdAt: z.string(),
  htmlUrl: z.string(),
}).passthrough();

const PullSchema = z.object({
  id: z.number(),
  number: z.number(),
  title: z.string(),
  state: z.string(),
  draft: z.boolean(),
  user: z.string().nullable(),
  head: z.string().nullable(),
  base: z.string().nullable(),
  merged: z.boolean(),
  createdAt: z.string(),
  htmlUrl: z.string(),
}).passthrough();

const MemberSchema = z.object({
  id: z.number(),
  login: z.string(),
  role: z.string().nullable(),
  type: z.string(),
  htmlUrl: z.string(),
}).passthrough();

function resolveOrg(
  methodOrg: string | undefined,
  globalOrg: string | undefined,
): string {
  const org = methodOrg ?? globalOrg;
  if (!org) throw new Error("org is required (set globally or per method)");
  return org;
}

function resolveOwner(
  methodOwner: string | undefined,
  globalOwner: string | undefined,
  globalOrg: string | undefined,
): string {
  const owner = methodOwner ?? globalOwner ?? globalOrg;
  if (!owner) {
    throw new Error("owner is required (set globally or per method)");
  }
  return owner;
}

export const model = {
  type: "@bixu/github",
  version: "2026.03.09.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    repo: {
      description: "GitHub repository",
      schema: RepoSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    issue: {
      description: "GitHub issue",
      schema: IssueSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    pull: {
      description: "GitHub pull request",
      schema: PullSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    member: {
      description: "GitHub organization member",
      schema: MemberSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    listRepos: {
      description: "List repositories for an organization",
      arguments: z.object({
        org: z.string().optional().describe("GitHub organization"),
        type: z.enum(["all", "public", "private", "forks", "sources", "member"])
          .default("all")
          .describe("Filter by repo type"),
        sort: z.enum(["created", "updated", "pushed", "full_name"])
          .default("full_name")
          .describe("Sort field"),
        json: z.boolean().default(false).describe(
          "Output raw JSON instead of a table",
        ),
      }),
      execute: async (args, context) => {
        const client = createClient(context.globalArgs.token);
        const org = resolveOrg(args.org, context.globalArgs.org);

        const repos = await client.paginate(client.rest.repos.listForOrg, {
          org,
          per_page: 100,
          type: args.type,
          sort: args.sort,
        });

        const handles = [];
        const normalized = [];
        for (const r of repos) {
          const data = normalizeRepo(r);
          normalized.push(data);
          const handle = await context.writeResource(
            "repo",
            String(data.name),
            data,
          );
          handles.push(handle);
        }

        const output = args.json
          ? JSON.stringify(normalized, null, 2) + "\n"
          : buildRepoTable(normalized).join("\n") + "\n";
        await Deno.stdout.write(new TextEncoder().encode(output));

        return { dataHandles: handles };
      },
    },

    getRepo: {
      description: "Get details for a single repository",
      arguments: z.object({
        repo: z.string().describe("Repository name"),
        owner: z.string().optional().describe(
          "Repository owner (defaults to org or owner global arg)",
        ),
      }),
      execute: async (args, context) => {
        const client = createClient(context.globalArgs.token);
        const owner = resolveOwner(
          args.owner,
          context.globalArgs.owner,
          context.globalArgs.org,
        );

        const { data } = await client.rest.repos.get({
          owner,
          repo: args.repo,
        });
        const normalized = normalizeRepo(data);

        const handle = await context.writeResource(
          "repo",
          String(normalized.name),
          normalized,
        );
        return { dataHandles: [handle] };
      },
    },

    listIssues: {
      description: "List issues for a repository",
      arguments: z.object({
        repo: z.string().describe("Repository name"),
        owner: z.string().optional().describe("Repository owner"),
        state: z.enum(["open", "closed", "all"]).default("open").describe(
          "Filter by state",
        ),
        labels: z.string().optional().describe(
          "Comma-separated list of label names to filter by",
        ),
        json: z.boolean().default(false).describe("Output raw JSON"),
      }),
      execute: async (args, context) => {
        const client = createClient(context.globalArgs.token);
        const owner = resolveOwner(
          args.owner,
          context.globalArgs.owner,
          context.globalArgs.org,
        );

        // deno-lint-ignore no-explicit-any
        const params: any = {
          owner,
          repo: args.repo,
          state: args.state,
          per_page: 100,
        };
        if (args.labels) params.labels = args.labels;

        const issues = await client.paginate(
          client.rest.issues.listForRepo,
          params,
        );

        // Filter out pull requests (GitHub API includes them in issues)
        // deno-lint-ignore no-explicit-any
        const realIssues = (issues as any[]).filter((i) => !i.pull_request);

        const handles = [];
        const normalized = [];
        for (const i of realIssues) {
          const data = normalizeIssue(i);
          normalized.push(data);
          const handle = await context.writeResource(
            "issue",
            `${args.repo}-${data.number}`,
            data,
          );
          handles.push(handle);
        }

        if (args.json) {
          const output = JSON.stringify(normalized, null, 2) + "\n";
          await Deno.stdout.write(new TextEncoder().encode(output));
        }

        return { dataHandles: handles };
      },
    },

    listPulls: {
      description: "List pull requests for a repository",
      arguments: z.object({
        repo: z.string().describe("Repository name"),
        owner: z.string().optional().describe("Repository owner"),
        state: z.enum(["open", "closed", "all"]).default("open").describe(
          "Filter by state",
        ),
        json: z.boolean().default(false).describe("Output raw JSON"),
      }),
      execute: async (args, context) => {
        const client = createClient(context.globalArgs.token);
        const owner = resolveOwner(
          args.owner,
          context.globalArgs.owner,
          context.globalArgs.org,
        );

        const pulls = await client.paginate(client.rest.pulls.list, {
          owner,
          repo: args.repo,
          state: args.state,
          per_page: 100,
        });

        const handles = [];
        const normalized = [];
        // deno-lint-ignore no-explicit-any
        for (const p of pulls as any[]) {
          const data = normalizePull(p);
          normalized.push(data);
          const handle = await context.writeResource(
            "pull",
            `${args.repo}-${data.number}`,
            data,
          );
          handles.push(handle);
        }

        if (args.json) {
          const output = JSON.stringify(normalized, null, 2) + "\n";
          await Deno.stdout.write(new TextEncoder().encode(output));
        }

        return { dataHandles: handles };
      },
    },

    listMembers: {
      description: "List members of an organization",
      arguments: z.object({
        org: z.string().optional().describe("GitHub organization"),
        role: z.enum(["all", "admin", "member"]).default("all").describe(
          "Filter by role",
        ),
        json: z.boolean().default(false).describe("Output raw JSON"),
      }),
      execute: async (args, context) => {
        const client = createClient(context.globalArgs.token);
        const org = resolveOrg(args.org, context.globalArgs.org);

        const members = await client.paginate(client.rest.orgs.listMembers, {
          org,
          role: args.role,
          per_page: 100,
        });

        const handles = [];
        const normalized = [];
        // deno-lint-ignore no-explicit-any
        for (const m of members as any[]) {
          const data = normalizeMember(m);
          normalized.push(data);
          const handle = await context.writeResource(
            "member",
            String(data.login),
            data,
          );
          handles.push(handle);
        }

        if (args.json) {
          const output = JSON.stringify(normalized, null, 2) + "\n";
          await Deno.stdout.write(new TextEncoder().encode(output));
        }

        return { dataHandles: handles };
      },
    },
  },
};
