import { z } from "npm:zod@4";
import { TailscaleGlobalArgsSchema, tsApi } from "./_helpers.ts";

const SettingsSchema = z
  .object({
    devicesApprovalOn: z.boolean(),
    devicesAutoUpdatesOn: z.boolean(),
    devicesKeyDurationDays: z.number(),
    usersApprovalOn: z.boolean(),
    usersRoleAllowedToJoinExternalTailnets: z.string(),
    networkFlowLoggingOn: z.boolean(),
    regionalRoutingOn: z.boolean(),
    postureIdentityCollectionOn: z.boolean(),
  })
  .passthrough();

export const model = {
  type: "@john/tailscale-settings",
  version: "2026.02.28.1",
  globalArguments: TailscaleGlobalArgsSchema,
  resources: {
    settings: {
      description: "Tailnet settings",
      schema: SettingsSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    get: {
      description: "Get current tailnet settings.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const tailnet = encodeURIComponent(g.tailnet);
        const resp = await tsApi(
          g,
          "GET",
          `/api/v2/tailnet/${tailnet}/settings`,
        );
        const handle = await context.writeResource(
          "settings",
          "current",
          resp,
        );
        return { dataHandles: [handle] };
      },
    },

    update: {
      description: "Update tailnet settings (partial update).",
      arguments: z.object({
        devicesApprovalOn: z.boolean().optional().describe(
          "Require device approval",
        ),
        devicesAutoUpdatesOn: z.boolean().optional().describe(
          "Enable auto-updates",
        ),
        devicesKeyDurationDays: z.number().optional().describe(
          "Key duration in days",
        ),
        usersApprovalOn: z.boolean().optional().describe(
          "Require user approval",
        ),
        usersRoleAllowedToJoinExternalTailnets: z.string().optional().describe(
          "Role allowed to join external tailnets",
        ),
        networkFlowLoggingOn: z.boolean().optional().describe(
          "Enable network flow logging",
        ),
        regionalRoutingOn: z.boolean().optional().describe(
          "Enable regional routing",
        ),
        postureIdentityCollectionOn: z.boolean().optional().describe(
          "Enable posture identity collection",
        ),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const tailnet = encodeURIComponent(g.tailnet);
        // Build patch body from provided fields only
        const patch = {};
        for (const [key, value] of Object.entries(args)) {
          if (value !== undefined) {
            patch[key] = value;
          }
        }
        await tsApi(
          g,
          "PATCH",
          `/api/v2/tailnet/${tailnet}/settings`,
          patch,
        );
        context.logger.info("Updated tailnet settings");
        const resp = await tsApi(
          g,
          "GET",
          `/api/v2/tailnet/${tailnet}/settings`,
        );
        const handle = await context.writeResource(
          "settings",
          "current",
          resp,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
