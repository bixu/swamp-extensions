// deno-lint-ignore-file no-import-prefix
import { z } from "npm:zod@4";
import {
  buildRunTable,
  createClient,
  normalizeRun,
  resolveGitHubToken,
} from "./github_actions_helpers.ts";

const GlobalArgsSchema = z.object({
  token: z.string().optional().describe(
    "GitHub token (auto-detected from GH_TOKEN, GITHUB_TOKEN, or gh CLI config)",
  ),
  owner: z.string().describe("Repository owner"),
  repo: z.string().describe("Repository name"),
});

const RunSchema = z.object({
  id: z.number(),
  name: z.string().nullable(),
  path: z.string().nullable(),
  status: z.string(),
  conclusion: z.string().nullable(),
  headBranch: z.string().nullable(),
  event: z.string(),
  runNumber: z.number(),
  runAttempt: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  htmlUrl: z.string(),
}).passthrough();

// deno-lint-ignore no-explicit-any
async function fetchPrRuns(pr: number, context: any) {
  const { owner, repo } = context.globalArgs;
  const token = await resolveGitHubToken(context.globalArgs.token);
  const client = createClient(token);

  const { data: pull } = await client.rest.pulls.get({
    owner,
    repo,
    pull_number: pr,
  });

  const { data } = await client.rest.actions.listWorkflowRunsForRepo({
    owner,
    repo,
    branch: pull.head.ref,
    event: "pull_request",
    per_page: 20,
  });

  const latestByWorkflow = new Map();
  for (const run of data.workflow_runs) {
    const key = run.workflow_id;
    if (!latestByWorkflow.has(key)) {
      latestByWorkflow.set(key, run);
    }
  }

  const runs = [...latestByWorkflow.values()];
  const handles = [];
  const normalized = [];

  for (const r of runs) {
    const d = normalizeRun(r);
    normalized.push(d);
    const handle = await context.writeResource(
      "run",
      `pr-${pr}-${d.id}`,
      d,
    );
    handles.push(handle);
  }

  return { normalized, handles };
}

export const model = {
  type: "@bixu/github/actions",
  version: "2026.05.05.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    run: {
      description: "GitHub Actions workflow run",
      schema: RunSchema,
      lifetime: "1d" as const,
      garbageCollection: 50,
    },
  },
  methods: {
    pr: {
      description: "Get the latest Actions runs for a pull request",
      arguments: z.object({
        pr: z.number().describe("Pull request number"),
        json: z.boolean().default(false).describe("Output raw JSON"),
      }),
      execute: async (args, context) => {
        const { normalized, handles } = await fetchPrRuns(args.pr, context);

        if (!args.json) {
          const table = buildRunTable(normalized);
          const output = table.join("\n") + "\n";
          await Deno.stdout.write(new TextEncoder().encode(output));
        } else {
          const output = JSON.stringify(normalized, null, 2) + "\n";
          await Deno.stdout.write(new TextEncoder().encode(output));
        }

        return { dataHandles: handles };
      },
    },
    watch: {
      description:
        "Poll a PR's workflow runs until all complete, printing status each interval",
      arguments: z.object({
        pr: z.number().describe("Pull request number"),
        interval: z.number().default(30).describe(
          "Polling interval in seconds (default: 30)",
        ),
      }),
      execute: async (args, context) => {
        const write = (s: string) =>
          Deno.stdout.write(new TextEncoder().encode(s));
        let handles: Awaited<
          ReturnType<typeof fetchPrRuns>
        >["handles"] = [];

        // deno-lint-ignore no-explicit-any
        const allDone = (runs: any[]) =>
          runs.length > 0 &&
          runs.every((r) => r.status === "completed");

        // deno-lint-ignore no-explicit-any
        const anyFailed = (runs: any[]) =>
          runs.some((r) => r.conclusion === "failure");

        while (true) {
          const result = await fetchPrRuns(args.pr, context);
          handles = result.handles;

          const table = buildRunTable(result.normalized);
          await write("\x1b[2J\x1b[H"); // clear screen
          await write(
            `PR #${args.pr} — ${new Date().toLocaleTimeString()}\n\n`,
          );
          await write(table.join("\n") + "\n");

          if (allDone(result.normalized)) {
            if (anyFailed(result.normalized)) {
              await write("\nSome workflows failed.\n");
            } else {
              await write("\nAll workflows passed.\n");
            }
            break;
          }

          await write(
            `\nPolling every ${args.interval}s... (Ctrl+C to stop)\n`,
          );
          await new Promise((r) => setTimeout(r, args.interval * 1000));
        }

        return { dataHandles: handles };
      },
    },
  },
};
