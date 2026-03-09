import { z } from "npm:zod@4";
import { createClient, normalizeIssue } from "./github_helpers.ts";

const GlobalArgsSchema = z.object({
  token: z.string().describe("GitHub personal access token"),
  org: z.string().optional().describe(
    "Default GitHub organization (can be overridden per method)",
  ),
  owner: z.string().optional().describe(
    "Default repository owner for repo-scoped methods",
  ),
});

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
  type: "@bixu/github/issue",
  version: "2026.03.09.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    issue: {
      description: "GitHub issue",
      schema: IssueSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    list: {
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
  },
};
