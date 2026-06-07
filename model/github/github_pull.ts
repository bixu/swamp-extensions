import { z } from "npm:zod@4";
import { createClient, normalizePull } from "./github_helpers.ts";

const GlobalArgsSchema = z.object({
  token: z.string().meta({ sensitive: true }).describe(
    "GitHub personal access token",
  ),
  org: z.string().optional().describe(
    "Default GitHub organization (can be overridden per method)",
  ),
  owner: z.string().optional().describe(
    "Default repository owner for repo-scoped methods",
  ),
});

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
  type: "@bixu/github/pull",
  version: "2026.03.09.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    pull: {
      description: "GitHub pull request",
      schema: PullSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    list: {
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
  },
};
