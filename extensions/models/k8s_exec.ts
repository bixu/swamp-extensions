/**
 * @module
 * Execute commands inside Kubernetes pods via the Kubernetes API.
 *
 * Provides two methods:
 * - **exec** — run a command in a single pod selected by name.
 * - **execAll** — run a command across all pods matching a label selector,
 *   in parallel with configurable concurrency.
 *
 * The `command` argument is intentionally a free-form shell string passed to
 * `sh -c` — this is a kubectl-exec replacement by design. Input validation
 * or allow-listing is the caller's responsibility.
 */
import { z } from "npm:zod@4";
import * as k8s from "npm:@kubernetes/client-node@1.4.0";
import { Buffer } from "node:buffer";
import { PassThrough } from "node:stream";

const GlobalArgsSchema = z.object({
  kubeContext: z.string().describe(
    "Kubernetes context name from your kubeconfig",
  ),
  namespace: z.string().default("kube-system").describe(
    "Default namespace for pod lookups",
  ),
  concurrency: z.number().default(10).describe(
    "Max pods to exec into in parallel (default: 10)",
  ),
});

const ExecResultSchema = z.object({
  podName: z.string(),
  nodeName: z.string(),
  container: z.string(),
  command: z.string(),
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number(),
  executedAt: z.string(),
});

const SummarySchema = z.object({
  method: z.string(),
  totalPods: z.number(),
  succeeded: z.number(),
  failed: z.number(),
  summary: z.string(),
  generatedAt: z.string(),
});

function loadKubeConfig(contextName: string): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  kc.setCurrentContext(contextName);
  return kc;
}

async function listPods(
  kc: k8s.KubeConfig,
  namespace: string,
  labelSelector?: string,
): Promise<Array<{ name: string; nodeName: string }>> {
  const coreV1 = kc.makeApiClient(k8s.CoreV1Api);
  const resp = await coreV1.listNamespacedPod({
    namespace,
    labelSelector,
    fieldSelector: "status.phase=Running",
  });
  return resp.items.map((p) => ({
    name: p.metadata!.name!,
    nodeName: p.spec!.nodeName || "unknown",
  }));
}

function execInPod(
  kc: k8s.KubeConfig,
  namespace: string,
  podName: string,
  container: string,
  command: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const exec = new k8s.Exec(kc);
    let stdout = "";
    let stderr = "";

    const stdoutStream = new PassThrough();
    const stderrStream = new PassThrough();

    stdoutStream.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    stderrStream.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    exec
      .exec(
        namespace,
        podName,
        container,
        command,
        stdoutStream,
        stderrStream,
        null,
        false,
        // deno-lint-ignore no-explicit-any
        (status: any) => {
          const code = status?.status === "Success"
            ? 0
            : Number(status?.details?.causes?.[0]?.message || 1);
          resolve({
            stdout: stdout.trimEnd(),
            stderr: stderr.trimEnd(),
            exitCode: code,
          });
        },
      )
      .catch(reject);
  });
}

async function runBatched<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

/**
 * Swamp extension model for executing commands inside Kubernetes pods.
 *
 * Resources produced:
 * - `execResult` — stdout, stderr, and exit code from a single pod exec.
 * - `summary` — aggregate pass/fail counts for a fleet-wide execAll run.
 */
export const model = {
  type: "@bixu/k8s/exec",
  version: "2026.04.23.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    execResult: {
      description: "Result of executing a command in a Kubernetes pod",
      schema: ExecResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
    summary: {
      description: "Summary of a batch exec operation",
      schema: SummarySchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    exec: {
      description:
        "Execute a command in a single pod, selected by name or label selector",
      arguments: z.object({
        pod: z.string().describe("Pod name (exact match)"),
        container: z.string().default("").describe(
          "Container name (empty = default container)",
        ),
        namespace: z.string().optional().describe(
          "Override namespace for this exec",
        ),
        command: z.string().describe("Command to run (passed to sh -c)"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const ns = args.namespace ?? g.namespace;
        const kc = loadKubeConfig(g.kubeContext);

        context.logger.info("Exec in {pod}/{container} ns={ns}", {
          pod: args.pod,
          container: args.container || "(default)",
          ns,
        });

        // Look up pod to get nodeName
        const coreV1 = kc.makeApiClient(k8s.CoreV1Api);
        const podObj = await coreV1.readNamespacedPod({
          name: args.pod,
          namespace: ns,
        });
        const nodeName = podObj.spec?.nodeName || "unknown";
        const containerName = args.container ||
          podObj.spec?.containers?.[0]?.name ||
          "unknown";

        const result = await execInPod(
          kc,
          ns,
          args.pod,
          containerName,
          ["sh", "-c", args.command],
        );

        const data = {
          podName: args.pod,
          nodeName,
          container: containerName,
          command: args.command,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          executedAt: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "execResult",
          args.pod,
          data,
        );

        const output = result.stdout || result.stderr;
        if (output) {
          await Deno.stdout.write(
            new TextEncoder().encode(
              `[${args.pod} @ ${nodeName}]\n${output}\n`,
            ),
          );
        }

        return { dataHandles: [handle] };
      },
    },

    execAll: {
      description:
        "Execute a command across multiple pods matching a label selector, in parallel",
      arguments: z.object({
        labelSelector: z.string().describe(
          "Kubernetes label selector (e.g. app=ovs)",
        ),
        container: z.string().default("").describe(
          "Container name (empty = default container)",
        ),
        namespace: z.string().optional().describe(
          "Override namespace for this exec",
        ),
        command: z.string().describe("Command to run (passed to sh -c)"),
        podFilter: z.string().optional().describe(
          "Regex filter on pod name (e.g. 'ovs-ovn-(p2979|ttvxz|7tkxv|46nf6)')",
        ),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const ns = args.namespace ?? g.namespace;
        const kc = loadKubeConfig(g.kubeContext);

        let pods = await listPods(kc, ns, args.labelSelector);

        if (args.podFilter) {
          if (args.podFilter.length > 200) {
            throw new Error(
              "podFilter pattern exceeds maximum length of 200 characters",
            );
          }
          let re: RegExp;
          try {
            re = new RegExp(args.podFilter);
          } catch (e) {
            throw new Error(`Invalid podFilter regex: ${e}`);
          }
          pods = pods.filter((p) => re.test(p.name));
        }

        context.logger.info(
          "Executing across {count} pods (concurrency={concurrency})",
          { count: pods.length, concurrency: g.concurrency },
        );

        const handles = [];
        let succeeded = 0;
        let failed = 0;
        const lines: string[] = [];

        const results = await runBatched(
          pods,
          g.concurrency,
          async (pod) => {
            // Resolve container name
            const coreV1 = kc.makeApiClient(k8s.CoreV1Api);
            const podObj = await coreV1.readNamespacedPod({
              name: pod.name,
              namespace: ns,
            });
            const containerName = args.container ||
              podObj.spec?.containers?.[0]?.name ||
              "unknown";

            const result = await execInPod(
              kc,
              ns,
              pod.name,
              containerName,
              ["sh", "-c", args.command],
            );

            return { pod, containerName, result };
          },
        );

        for (const r of results) {
          if (r.status === "fulfilled") {
            const { pod, containerName, result } = r.value;
            succeeded++;

            const data = {
              podName: pod.name,
              nodeName: pod.nodeName,
              container: containerName,
              command: args.command,
              stdout: result.stdout,
              stderr: result.stderr,
              exitCode: result.exitCode,
              executedAt: new Date().toISOString(),
            };

            const handle = await context.writeResource(
              "execResult",
              pod.name,
              data,
            );
            handles.push(handle);

            const output = result.stdout || result.stderr;
            if (output) {
              lines.push(`[${pod.name} @ ${pod.nodeName}]\n${output}`);
            }
          } else {
            failed++;
            lines.push(`[FAILED] ${r.reason}`);
          }
        }

        // Print all output
        if (lines.length > 0) {
          await Deno.stdout.write(
            new TextEncoder().encode(lines.join("\n\n") + "\n"),
          );
        }

        const summaryHandle = await context.writeResource(
          "summary",
          "execAll",
          {
            method: "execAll",
            totalPods: pods.length,
            succeeded,
            failed,
            summary:
              `Executed '${args.command}' across ${pods.length} pods: ${succeeded} succeeded, ${failed} failed`,
            generatedAt: new Date().toISOString(),
          },
        );

        return { dataHandles: [summaryHandle, ...handles] };
      },
    },
  },
  upgrades: [
    {
      fromVersion: "2026.03.17.1",
      toVersion: "2026.04.23.1",
      description: "Guard podFilter against ReDoS; add quality metadata",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
};
