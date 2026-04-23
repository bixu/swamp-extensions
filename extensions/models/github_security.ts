import { z } from "npm:zod@4";
import { Octokit } from "npm:@octokit/rest@22.0.1";
import {
  buildSecurityMarkdown,
  buildSecuritySummary,
  buildSecurityTable,
  fetchOrgRepoSecurity,
  fetchUserRepoSecurity,
} from "./github_security_helpers.ts";

const GlobalArgsSchema = z.object({
  token: z.string().meta({ sensitive: true }).describe(
    "GitHub personal access token",
  ),
});

const SummarySchema = z.object({
  totalRepos: z.number(),
  activeRepos: z.number(),
  archivedRepos: z.number(),
  ownedRepos: z.number(),
  forkedRepos: z.number(),
  publicRepos: z.number(),
  privateRepos: z.number(),
  secretScanningEnabled: z.number(),
  secretScanningPushProtection: z.number(),
  dependabotSecurityUpdates: z.number(),
  codeScanningEnabled: z.number(),
  totalCodeScanningAlerts: z.number(),
  reposWithSecurityApps: z.number(),
  reposWithSecurityChecks: z.number(),
  securityAppCoverage: z.record(z.string(), z.number()),
  reposMissingFeatures: z.array(z.object({
    name: z.string(),
    visibility: z.string(),
    secretScanningEnabled: z.boolean(),
    secretScanningPushProtection: z.boolean(),
    dependabotSecurityUpdates: z.boolean(),
    codeScanningEnabled: z.boolean(),
    codeScanningAlertCount: z.number(),
    securityApps: z.array(z.string()),
    securityChecks: z.array(z.string()),
  })),
}).passthrough();

const RepoStatusSchema = z.object({
  name: z.string(),
  visibility: z.string(),
  secretScanningEnabled: z.boolean(),
  secretScanningPushProtection: z.boolean(),
  dependabotSecurityUpdates: z.boolean(),
  codeScanningEnabled: z.boolean(),
  codeScanningAlertCount: z.number(),
  securityApps: z.array(z.string()),
  securityChecks: z.array(z.string()),
}).passthrough();

export const model = {
  type: "@bixu/github-security",
  version: "2026.03.09.3",
  globalArguments: GlobalArgsSchema,
  resources: {
    summary: {
      description: "Security summary for an account or organization",
      schema: SummarySchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    repo: {
      description: "Per-repo security status",
      schema: RepoStatusSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    scanUser: {
      description:
        "Scan all owned repos for a GitHub user and report security status",
      arguments: z.object({
        username: z.string().optional().describe(
          "GitHub username (omit for authenticated user)",
        ),
        format: z.enum(["text", "markdown", "json"]).default("text").describe(
          "Output format: text (default), markdown, or json",
        ),
      }),
      execute: async (args, context) => {
        const client = new Octokit({ auth: context.globalArgs.token });
        const label = args.username ?? "authenticated user";

        const statuses = await fetchUserRepoSecurity(client, args.username);

        // Fetch raw repos for summary counts (includes archived/forks)
        // deno-lint-ignore no-explicit-any
        let rawRepos: any[];
        if (args.username) {
          rawRepos = await client.paginate(client.rest.repos.listForUser, {
            username: args.username,
            per_page: 100,
            type: "owner",
          });
        } else {
          rawRepos = await client.paginate(
            client.rest.repos.listForAuthenticatedUser,
            { per_page: 100, type: "owner" },
          );
        }

        const summary = buildSecuritySummary(statuses, rawRepos);

        const handles = [];

        const summaryHandle = await context.writeResource(
          "summary",
          `summary-${label}`,
          summary,
        );
        handles.push(summaryHandle);

        for (const status of statuses) {
          const handle = await context.writeResource(
            "repo",
            status.name,
            status,
          );
          handles.push(handle);
        }

        const output = args.format === "json"
          ? JSON.stringify(summary, null, 2) + "\n"
          : args.format === "markdown"
          ? buildSecurityMarkdown(summary).join("\n") + "\n"
          : buildSecurityTable(summary).join("\n") + "\n";
        await Deno.stdout.write(new TextEncoder().encode(output));

        return { dataHandles: handles };
      },
    },

    scanOrg: {
      description:
        "Scan all repos in a GitHub organization and report security status",
      arguments: z.object({
        org: z.string().describe("GitHub organization name"),
        format: z.enum(["text", "markdown", "json"]).default("text").describe(
          "Output format: text (default), markdown, or json",
        ),
      }),
      execute: async (args, context) => {
        const client = new Octokit({ auth: context.globalArgs.token });

        const statuses = await fetchOrgRepoSecurity(client, args.org);

        const rawRepos = await client.paginate(client.rest.repos.listForOrg, {
          org: args.org,
          per_page: 100,
          type: "all",
        });

        const summary = buildSecuritySummary(statuses, rawRepos);

        const handles = [];

        const summaryHandle = await context.writeResource(
          "summary",
          `summary-${args.org}`,
          summary,
        );
        handles.push(summaryHandle);

        for (const status of statuses) {
          const handle = await context.writeResource(
            "repo",
            status.name,
            status,
          );
          handles.push(handle);
        }

        const output = args.format === "json"
          ? JSON.stringify(summary, null, 2) + "\n"
          : args.format === "markdown"
          ? buildSecurityMarkdown(summary).join("\n") + "\n"
          : buildSecurityTable(summary).join("\n") + "\n";
        await Deno.stdout.write(new TextEncoder().encode(output));

        return { dataHandles: handles };
      },
    },
  },
};
