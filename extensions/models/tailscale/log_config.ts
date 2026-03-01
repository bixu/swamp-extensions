import { z } from "npm:zod@4";
import { TailscaleGlobalArgsSchema, tsApi } from "./_helpers.ts";

const LogConfigSchema = z
  .object({
    destinationUrl: z.string(),
    streamingEnabled: z.boolean(),
    enabled: z.boolean(),
  })
  .passthrough();

export const model = {
  type: "@john/tailscale-log-config",
  version: "2026.02.28.1",
  globalArguments: TailscaleGlobalArgsSchema,
  resources: {
    logConfig: {
      description: "Tailnet log streaming configuration",
      schema: LogConfigSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    get: {
      description: "Get log streaming configuration for a log type.",
      arguments: z.object({
        logType: z
          .string()
          .describe("Log type: 'configuration' or 'network'"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const tailnet = encodeURIComponent(g.tailnet);
        const resp = await tsApi(
          g,
          "GET",
          `/api/v2/tailnet/${tailnet}/logging/${encodeURIComponent(args.logType)}/stream`,
        );
        const handle = await context.writeResource(
          "logConfig",
          args.logType,
          resp,
        );
        return { dataHandles: [handle] };
      },
    },

    set: {
      description: "Set log streaming configuration for a log type.",
      arguments: z.object({
        logType: z
          .string()
          .describe("Log type: 'configuration' or 'network'"),
        destinationUrl: z
          .string()
          .describe("Log destination URL"),
        streamingEnabled: z
          .boolean()
          .default(true)
          .describe("Enable streaming"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const tailnet = encodeURIComponent(g.tailnet);
        const body = {
          destinationUrl: args.destinationUrl,
          streamingEnabled: args.streamingEnabled,
        };
        await tsApi(
          g,
          "PUT",
          `/api/v2/tailnet/${tailnet}/logging/${encodeURIComponent(args.logType)}/stream`,
          body,
        );
        context.logger.info("Set log config for {logType}", {
          logType: args.logType,
        });
        const resp = await tsApi(
          g,
          "GET",
          `/api/v2/tailnet/${tailnet}/logging/${encodeURIComponent(args.logType)}/stream`,
        );
        const handle = await context.writeResource(
          "logConfig",
          args.logType,
          resp,
        );
        return { dataHandles: [handle] };
      },
    },

    delete: {
      description: "Delete log streaming configuration for a log type.",
      arguments: z.object({
        logType: z
          .string()
          .describe("Log type: 'configuration' or 'network'"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const tailnet = encodeURIComponent(g.tailnet);
        await tsApi(
          g,
          "DELETE",
          `/api/v2/tailnet/${tailnet}/logging/${encodeURIComponent(args.logType)}/stream`,
        );
        context.logger.info("Deleted log config for {logType}", {
          logType: args.logType,
        });
        return { dataHandles: [] };
      },
    },
  },
};
