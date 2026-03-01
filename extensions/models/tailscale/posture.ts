import { z } from "npm:zod@4";
import {
  TailscaleGlobalArgsSchema,
  tsApi,
  sanitizeInstanceName,
} from "./_helpers.ts";

const PostureIntegrationSchema = z
  .object({
    id: z.string(),
    provider: z.string(),
    cloudId: z.string(),
    clientId: z.string(),
    tenantId: z.string(),
  })
  .passthrough();

function normalizeIntegration(raw) {
  return {
    id: raw.id || "",
    provider: raw.provider || "",
    cloudId: raw.cloudId || "",
    clientId: raw.clientId || "",
    tenantId: raw.tenantId || "",
  };
}

export const model = {
  type: "@john/tailscale-posture",
  version: "2026.02.28.1",
  globalArguments: TailscaleGlobalArgsSchema,
  resources: {
    integration: {
      description: "Tailscale posture integration",
      schema: PostureIntegrationSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    list: {
      description:
        "List all posture integrations. Produces one resource instance per integration (factory pattern).",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const tailnet = encodeURIComponent(g.tailnet);
        const resp = await tsApi(
          g,
          "GET",
          `/api/v2/tailnet/${tailnet}/posture/integrations`,
        );
        const integrations = resp.integrations || resp || [];
        const items = Array.isArray(integrations) ? integrations : [];

        context.logger.info("Found {count} posture integrations", {
          count: items.length,
        });

        const handles = [];
        for (const raw of items) {
          const integration = normalizeIntegration(raw);
          const handle = await context.writeResource(
            "integration",
            sanitizeInstanceName(integration.id),
            integration,
          );
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    get: {
      description: "Get a posture integration by ID.",
      arguments: z.object({
        integrationId: z.string().describe("Posture integration ID"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const tailnet = encodeURIComponent(g.tailnet);
        const resp = await tsApi(
          g,
          "GET",
          `/api/v2/tailnet/${tailnet}/posture/integrations/${encodeURIComponent(args.integrationId)}`,
        );
        const integration = normalizeIntegration(resp);
        const handle = await context.writeResource(
          "integration",
          sanitizeInstanceName(integration.id),
          integration,
        );
        return { dataHandles: [handle] };
      },
    },

    create: {
      description: "Create a new posture integration.",
      arguments: z.object({
        provider: z.string().describe("Provider name"),
        cloudId: z.string().default("").describe("Cloud ID"),
        clientId: z.string().default("").describe("Client ID"),
        tenantId: z.string().default("").describe("Tenant ID"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const tailnet = encodeURIComponent(g.tailnet);
        const resp = await tsApi(
          g,
          "POST",
          `/api/v2/tailnet/${tailnet}/posture/integrations`,
          {
            provider: args.provider,
            cloudId: args.cloudId,
            clientId: args.clientId,
            tenantId: args.tenantId,
          },
        );
        const integration = normalizeIntegration(resp);
        context.logger.info("Created posture integration {id}", {
          id: integration.id,
        });
        const handle = await context.writeResource(
          "integration",
          sanitizeInstanceName(integration.id),
          integration,
        );
        return { dataHandles: [handle] };
      },
    },

    update: {
      description: "Update a posture integration.",
      arguments: z.object({
        integrationId: z.string().describe("Posture integration ID"),
        cloudId: z.string().optional().describe("Cloud ID"),
        clientId: z.string().optional().describe("Client ID"),
        tenantId: z.string().optional().describe("Tenant ID"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const tailnet = encodeURIComponent(g.tailnet);
        const patch = {};
        if (args.cloudId !== undefined) patch.cloudId = args.cloudId;
        if (args.clientId !== undefined) patch.clientId = args.clientId;
        if (args.tenantId !== undefined) patch.tenantId = args.tenantId;
        const resp = await tsApi(
          g,
          "PATCH",
          `/api/v2/tailnet/${tailnet}/posture/integrations/${encodeURIComponent(args.integrationId)}`,
          patch,
        );
        const integration = normalizeIntegration(resp);
        context.logger.info("Updated posture integration {id}", {
          id: integration.id,
        });
        const handle = await context.writeResource(
          "integration",
          sanitizeInstanceName(integration.id),
          integration,
        );
        return { dataHandles: [handle] };
      },
    },

    delete: {
      description: "Delete a posture integration.",
      arguments: z.object({
        integrationId: z
          .string()
          .describe("Posture integration ID to delete"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const tailnet = encodeURIComponent(g.tailnet);
        await tsApi(
          g,
          "DELETE",
          `/api/v2/tailnet/${tailnet}/posture/integrations/${encodeURIComponent(args.integrationId)}`,
        );
        context.logger.info("Deleted posture integration {id}", {
          id: args.integrationId,
        });
        return { dataHandles: [] };
      },
    },
  },
};
