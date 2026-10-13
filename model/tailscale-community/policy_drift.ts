// Derived from @sntxrr/tailscale-acl-drift@2026.07.24.2 (models/tailscale_acl_drift.ts), MIT, Copyright (c) 2026 sntxrr.
/**
 * Drift detection for GitOps-managed Tailscale ACL policies.
 *
 * Extends `@swamp/tailscale/policy-file` with a read-only `drift` method that compares
 * the policy currently live on the tailnet against the `policy.hujson` file in
 * a GitOps repository. It performs no writes to the tailnet — applying policy
 * remains the sole responsibility of the GitOps pipeline, preserving a single
 * writer and avoiding last-push-wins races.
 *
 * Intended use: run `@swamp/tailscale/policy-file`'s `get` method first to snapshot the
 * live policy, then run `drift` to compare that snapshot against the file.
 *
 * @module
 */

import { z } from "npm:zod@4";
import {
  comparePolicies,
  hasComments,
  type Json,
  parseHujson,
  parseLivePolicy,
} from "./hujson.ts";

/** Shape of a detected difference between live and file policy. */
const DifferenceSchema = z.object({
  section: z.string().describe(
    "Top-level policy key that differs (e.g. acls, grants, ssh, tagOwners).",
  ),
  state: z
    .enum(["only-live", "only-file", "changed"])
    .describe(
      "Where the section diverges: present only on the tailnet, only in the file, or present in both with different contents.",
    ),
});

/** Result snapshot written by the `drift` method. */
const DriftSchema = z.object({
  inSync: z
    .boolean()
    .describe("True when live tailnet policy matches the file semantically."),
  policyPath: z
    .string()
    .describe("Filesystem path of the GitOps policy file that was compared."),
  differences: z
    .array(DifferenceSchema)
    .describe("Per-section differences; empty when in sync."),
  commentsPresent: z
    .boolean()
    .describe(
      "True when the local policy file contains comments — these are stripped before comparison and are never treated as drift.",
    ),
  summary: z
    .string()
    .describe("Human-readable one-line summary suitable for alerting."),
});

export const extension = {
  type: "@swamp/tailscale/policy-file",

  resources: {
    drift: {
      description:
        "Comparison between the live tailnet ACL policy and the GitOps policy file.",
      schema: DriftSchema,
      lifetime: "infinite",
      garbageCollection: 30,
    },
  },

  methods: [
    {
      drift: {
        description:
          "Compare the live tailnet ACL policy against a GitOps policy.hujson file. Read-only — never writes to the tailnet.",
        arguments: z.object({
          policyPath: z
            .string()
            .describe(
              "Absolute path to the GitOps policy.hujson file to compare against.",
            ),
          liveInstance: z
            .string()
            .default("current")
            .describe(
              "Instance name of the ACL snapshot written by the `get` method.",
            ),
        }),
        execute: async (
          args: { policyPath: string; liveInstance: string },
          context: {
            readResource?: (
              instanceName: string,
              version?: number,
            ) => Promise<Record<string, unknown> | null>;
            writeResource: (
              spec: string,
              instance: string,
              data: unknown,
            ) => Promise<unknown>;
            logger: {
              info: (msg: string, props?: Record<string, unknown>) => void;
              warning: (msg: string, props?: Record<string, unknown>) => void;
            };
          },
        ): Promise<{ dataHandles: unknown[] }> => {
          const live = await context.readResource?.(args.liveInstance);
          if (!live) {
            throw new Error(
              `No ACL snapshot found under instance "${args.liveInstance}". Run the \`get\` method on this model first.`,
            );
          }

          let source: string;
          try {
            source = await Deno.readTextFile(args.policyPath);
          } catch (e) {
            throw new Error(
              `Could not read policy file at ${args.policyPath}: ${
                (e as Error).message
              }`,
            );
          }

          const commentsPresent = hasComments(source);

          let filePolicy: Json;
          try {
            filePolicy = parseHujson(source);
          } catch (e) {
            throw new Error(
              `Failed to parse HuJSON at ${args.policyPath}: ${
                (e as Error).message
              }`,
            );
          }

          if (
            filePolicy === null || typeof filePolicy !== "object" ||
            Array.isArray(filePolicy)
          ) {
            throw new Error(
              `Policy file at ${args.policyPath} did not parse to an object.`,
            );
          }

          const differences = comparePolicies(
            parseLivePolicy(live),
            filePolicy as Record<string, Json>,
          );
          const inSync = differences.length === 0;

          const summary = inSync
            ? "Tailnet ACL policy matches the GitOps file."
            : `Tailnet ACL policy has drifted from the GitOps file in ${differences.length} section(s): ${
              differences.map((d) => `${d.section} (${d.state})`).join(", ")
            }.`;

          if (inSync) {
            context.logger.info("ACL policy in sync with {path}", {
              path: args.policyPath,
            });
          } else {
            context.logger.warning("ACL drift detected: {summary}", {
              summary,
            });
          }

          // Instance names are NOT namespaced by resource spec — writing this
          // under "current" would version it into the same data name the base
          // model's `get` writes its ACL snapshot to, so a subsequent
          // readResource("current") would return a drift report instead of a
          // policy. Keep it under its own name.
          const handle = await context.writeResource("drift", "drift", {
            inSync,
            policyPath: args.policyPath,
            differences,
            commentsPresent,
            summary,
          });

          return { dataHandles: [handle] };
        },
      },
    },
  ],
};
