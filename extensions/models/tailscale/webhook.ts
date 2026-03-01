import { z } from "npm:zod@4";
import {
  TailscaleGlobalArgsSchema,
  tsApi,
  sanitizeInstanceName,
} from "./_helpers.ts";

const WebhookSchema = z
  .object({
    endpointId: z.string(),
    endpointUrl: z.string(),
    providerType: z.string(),
    creatorLoginName: z.string(),
    created: z.string(),
    lastModified: z.string(),
    subscriptions: z.array(z.string()),
    secret: z.string().meta({ sensitive: true }).optional(),
  })
  .passthrough();

function normalizeWebhook(raw) {
  return {
    endpointId: raw.endpointId || "",
    endpointUrl: raw.endpointUrl || "",
    providerType: raw.providerType || "",
    creatorLoginName: raw.creatorLoginName || "",
    created: raw.created || "",
    lastModified: raw.lastModified || "",
    subscriptions: raw.subscriptions || [],
    ...(raw.secret != null ? { secret: raw.secret } : {}),
  };
}

export const model = {
  type: "@john/tailscale-webhook",
  version: "2026.02.28.1",
  globalArguments: TailscaleGlobalArgsSchema,
  resources: {
    webhook: {
      description: "Tailscale webhook endpoint",
      schema: WebhookSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    list: {
      description:
        "List all webhooks in the tailnet. Produces one resource instance per webhook (factory pattern).",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const tailnet = encodeURIComponent(g.tailnet);
        const resp = await tsApi(
          g,
          "GET",
          `/api/v2/tailnet/${tailnet}/webhooks`,
        );
        const webhooks = resp.webhooks || [];

        context.logger.info("Found {count} webhooks", {
          count: webhooks.length,
        });

        const handles = [];
        for (const raw of webhooks) {
          const wh = normalizeWebhook(raw);
          const handle = await context.writeResource(
            "webhook",
            sanitizeInstanceName(wh.endpointId),
            wh,
          );
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    get: {
      description: "Get a single webhook by endpoint ID.",
      arguments: z.object({
        endpointId: z.string().describe("Webhook endpoint ID"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const resp = await tsApi(
          g,
          "GET",
          `/api/v2/webhooks/${encodeURIComponent(args.endpointId)}`,
        );
        const wh = normalizeWebhook(resp);
        const handle = await context.writeResource(
          "webhook",
          sanitizeInstanceName(wh.endpointId),
          wh,
        );
        return { dataHandles: [handle] };
      },
    },

    create: {
      description: "Create a new webhook.",
      arguments: z.object({
        endpointUrl: z.string().describe("URL to receive webhook events"),
        providerType: z
          .string()
          .default("")
          .describe(
            "Provider type: '' (generic), 'slack', 'mattermost', 'googlechat', 'discord'",
          ),
        subscriptions: z
          .array(z.string())
          .describe(
            "Event types to subscribe to, e.g. ['nodeCreated', 'userCreated']",
          ),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const tailnet = encodeURIComponent(g.tailnet);
        const resp = await tsApi(
          g,
          "POST",
          `/api/v2/tailnet/${tailnet}/webhooks`,
          {
            endpointUrl: args.endpointUrl,
            providerType: args.providerType,
            subscriptions: args.subscriptions,
          },
        );
        const wh = normalizeWebhook(resp);
        context.logger.info("Created webhook {endpointId}", {
          endpointId: wh.endpointId,
        });
        const handle = await context.writeResource(
          "webhook",
          sanitizeInstanceName(wh.endpointId),
          wh,
        );
        return { dataHandles: [handle] };
      },
    },

    update: {
      description: "Update a webhook's subscriptions.",
      arguments: z.object({
        endpointId: z.string().describe("Webhook endpoint ID"),
        subscriptions: z
          .array(z.string())
          .describe("New event subscriptions"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const resp = await tsApi(
          g,
          "PATCH",
          `/api/v2/webhooks/${encodeURIComponent(args.endpointId)}`,
          { subscriptions: args.subscriptions },
        );
        const wh = normalizeWebhook(resp);
        context.logger.info("Updated webhook {endpointId}", {
          endpointId: wh.endpointId,
        });
        const handle = await context.writeResource(
          "webhook",
          sanitizeInstanceName(wh.endpointId),
          wh,
        );
        return { dataHandles: [handle] };
      },
    },

    delete: {
      description: "Delete a webhook.",
      arguments: z.object({
        endpointId: z.string().describe("Webhook endpoint ID to delete"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        await tsApi(
          g,
          "DELETE",
          `/api/v2/webhooks/${encodeURIComponent(args.endpointId)}`,
        );
        context.logger.info("Deleted webhook {endpointId}", {
          endpointId: args.endpointId,
        });
        return { dataHandles: [] };
      },
    },

    test: {
      description: "Send a test event to a webhook.",
      arguments: z.object({
        endpointId: z.string().describe("Webhook endpoint ID to test"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        await tsApi(
          g,
          "POST",
          `/api/v2/webhooks/${encodeURIComponent(args.endpointId)}/test`,
        );
        context.logger.info("Sent test event to webhook {endpointId}", {
          endpointId: args.endpointId,
        });
        const resp = await tsApi(
          g,
          "GET",
          `/api/v2/webhooks/${encodeURIComponent(args.endpointId)}`,
        );
        const wh = normalizeWebhook(resp);
        const handle = await context.writeResource(
          "webhook",
          sanitizeInstanceName(wh.endpointId),
          wh,
        );
        return { dataHandles: [handle] };
      },
    },

    rotateSecret: {
      description: "Rotate the secret for a webhook.",
      arguments: z.object({
        endpointId: z
          .string()
          .describe("Webhook endpoint ID to rotate secret for"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const resp = await tsApi(
          g,
          "POST",
          `/api/v2/webhooks/${encodeURIComponent(args.endpointId)}/rotate`,
        );
        const wh = normalizeWebhook(resp);
        context.logger.info("Rotated secret for webhook {endpointId}", {
          endpointId: wh.endpointId,
        });
        const handle = await context.writeResource(
          "webhook",
          sanitizeInstanceName(wh.endpointId),
          wh,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
