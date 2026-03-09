import { z } from "npm:zod@4";
import { createClient, normalizeMember } from "./github_helpers.ts";

const GlobalArgsSchema = z.object({
  token: z.string().describe("GitHub personal access token"),
  org: z.string().optional().describe(
    "Default GitHub organization (can be overridden per method)",
  ),
});

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

export const model = {
  type: "@bixu/github/member",
  version: "2026.03.09.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    member: {
      description: "GitHub organization member",
      schema: MemberSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    list: {
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
