import { z } from "npm:zod@4";
import {
  buildCodeSearchTable,
  buildRepoTable,
  createClient,
  normalizeCodeResult,
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

const CodeResultSchema = z.object({
  name: z.string(),
  path: z.string(),
  repository: z.string().nullable(),
  htmlUrl: z.string(),
  sha: z.string(),
  score: z.number().nullable(),
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
  type: "@bixu/github/repo",
  version: "2026.03.10.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    repo: {
      description: "GitHub repository",
      schema: RepoSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    codeResult: {
      description: "GitHub code search result",
      schema: CodeResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
  },
  methods: {
    list: {
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

    listForUser: {
      description:
        "List repositories for the authenticated user or a specified user",
      arguments: z.object({
        username: z.string().optional().describe(
          "GitHub username (omit to list repos for the authenticated user)",
        ),
        type: z.enum(["all", "owner", "member"]).default("owner").describe(
          "Filter by repo relationship to user",
        ),
        sort: z.enum(["created", "updated", "pushed", "full_name"])
          .default("full_name")
          .describe("Sort field"),
        json: z.boolean().default(false).describe(
          "Output raw JSON instead of a table",
        ),
      }),
      execute: async (args, context) => {
        const client = createClient(context.globalArgs.token);

        // deno-lint-ignore no-explicit-any
        let repos: any[];
        if (args.username) {
          repos = await client.paginate(client.rest.repos.listForUser, {
            username: args.username,
            per_page: 100,
            type: args.type,
            sort: args.sort,
          });
        } else {
          repos = await client.paginate(
            client.rest.repos.listForAuthenticatedUser,
            {
              per_page: 100,
              type: args.type,
              sort: args.sort,
            },
          );
        }

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

    get: {
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

    searchCode: {
      description:
        "Search code across repositories using GitHub code search syntax",
      arguments: z.object({
        query: z.string().describe(
          "Search query (GitHub code search syntax, e.g. 'ipv6 language:groovy')",
        ),
        org: z.string().optional().describe(
          "Organization to scope search to",
        ),
        repo: z.string().optional().describe(
          "Repository name to scope search to (requires org/owner)",
        ),
        owner: z.string().optional().describe(
          "Repository owner to scope search to (used with repo)",
        ),
        language: z.string().optional().describe(
          "Filter by programming language",
        ),
        path: z.string().optional().describe(
          "Filter by file path (e.g. 'Jenkinsfile' or '*.gradle')",
        ),
        limit: z.number().default(30).describe(
          "Maximum number of results to return",
        ),
        json: z.boolean().default(false).describe("Output raw JSON"),
      }),
      execute: async (args, context) => {
        const client = createClient(context.globalArgs.token);

        let q = args.query;
        const org = args.org ?? context.globalArgs.org;
        const owner = args.owner ?? context.globalArgs.owner ?? org;
        if (owner && args.repo) {
          q += ` repo:${owner}/${args.repo}`;
        } else if (org) {
          q += ` org:${org}`;
        }
        if (args.language) q += ` language:${args.language}`;
        if (args.path) q += ` path:${args.path}`;

        const resp = await client.rest.search.code({
          q,
          per_page: Math.min(args.limit, 100),
        });

        const handles = [];
        const normalized = [];
        for (const item of resp.data.items) {
          const data = normalizeCodeResult(item);
          normalized.push(data);
          const instanceName = `${data.repository}-${data.path}`.replaceAll(
            "/",
            "-",
          );
          const handle = await context.writeResource(
            "codeResult",
            instanceName,
            data,
          );
          handles.push(handle);
        }

        const output = args.json
          ? JSON.stringify(normalized, null, 2) + "\n"
          : buildCodeSearchTable(normalized).join("\n") + "\n";
        await Deno.stdout.write(new TextEncoder().encode(output));

        return { dataHandles: handles };
      },
    },
  },
};
