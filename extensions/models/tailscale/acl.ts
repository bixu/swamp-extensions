import { z } from "npm:zod@4";
import { TailscaleGlobalArgsSchema, tsApi } from "./_helpers.ts";

const AclSchema = z
  .object({
    acls: z
      .array(
        z
          .object({
            action: z.string(),
            src: z.array(z.string()).optional(),
            dst: z.array(z.string()).optional(),
            users: z.array(z.string()).optional(),
            ports: z.array(z.string()).optional(),
            proto: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
    groups: z.record(z.string(), z.array(z.string())).optional(),
    hosts: z.record(z.string(), z.string()).optional(),
    tagOwners: z.record(z.string(), z.array(z.string())).optional(),
    autoApprovers: z
      .object({
        routes: z.record(z.string(), z.array(z.string())).optional(),
        exitNode: z.array(z.string()).optional(),
      })
      .passthrough()
      .optional(),
    ssh: z
      .array(
        z
          .object({
            action: z.string(),
            src: z.array(z.string()).optional(),
            dst: z.array(z.string()).optional(),
            users: z.array(z.string()).optional(),
          })
          .passthrough(),
      )
      .optional(),
    nodeAttrs: z.array(z.any()).optional(),
    tests: z.array(z.any()).optional(),
  })
  .passthrough();

export const model = {
  type: "@john/tailscale-acl",
  version: "2026.02.28.1",
  globalArguments: TailscaleGlobalArgsSchema,
  resources: {
    acl: {
      description: "Tailnet ACL policy (JSON format)",
      schema: AclSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  files: {
    rawAcl: {
      description: "Tailnet ACL policy in HuJSON format",
      contentType: "text/plain",
      lifetime: "7d",
      garbageCollection: 5,
    },
  },
  methods: {
    get: {
      description: "Get the current ACL policy as JSON.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const tailnet = encodeURIComponent(g.tailnet);
        const resp = await tsApi(
          g,
          "GET",
          `/api/v2/tailnet/${tailnet}/acl`,
        );
        const handle = await context.writeResource("acl", "current", resp);
        return { dataHandles: [handle] };
      },
    },

    getRaw: {
      description: "Get the current ACL policy as HuJSON (raw text).",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const tailnet = encodeURIComponent(g.tailnet);
        const resp = await tsApi(
          g,
          "GET",
          `/api/v2/tailnet/${tailnet}/acl`,
          null,
          { Accept: "application/hujson" },
        );
        const writer = context.createFileWriter("rawAcl", "current");
        const handle = await writer.writeText(
          typeof resp === "string" ? resp : JSON.stringify(resp, null, 2),
        );
        return { dataHandles: [handle] };
      },
    },

    set: {
      description:
        "Set the ACL policy. Optionally provide an ETag for conditional update.",
      arguments: z.object({
        acl: z
          .record(z.string(), z.any())
          .describe("ACL policy object to set"),
        etag: z
          .string()
          .optional()
          .describe("ETag for If-Match conditional update"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const tailnet = encodeURIComponent(g.tailnet);
        const headers = {};
        if (args.etag) {
          headers["If-Match"] = `"${args.etag}"`;
        }
        await tsApi(
          g,
          "POST",
          `/api/v2/tailnet/${tailnet}/acl`,
          args.acl,
          headers,
        );
        context.logger.info("ACL policy updated");
        const resp = await tsApi(
          g,
          "GET",
          `/api/v2/tailnet/${tailnet}/acl`,
        );
        const handle = await context.writeResource("acl", "current", resp);
        return { dataHandles: [handle] };
      },
    },

    validate: {
      description: "Validate an ACL policy without applying it.",
      arguments: z.object({
        acl: z
          .record(z.string(), z.any())
          .describe("ACL policy object to validate"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const tailnet = encodeURIComponent(g.tailnet);
        await tsApi(
          g,
          "POST",
          `/api/v2/tailnet/${tailnet}/acl/validate`,
          args.acl,
        );
        context.logger.info("ACL policy validated successfully");
        const handle = await context.writeResource("acl", "validated", args.acl);
        return { dataHandles: [handle] };
      },
    },
  },
};
