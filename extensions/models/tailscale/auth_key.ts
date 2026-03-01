import { z } from "npm:zod@4";
import {
  TailscaleGlobalArgsSchema,
  tsApi,
  sanitizeInstanceName,
} from "./_helpers.ts";

const KeySchema = z
  .object({
    id: z.string(),
    key: z.string().meta({ sensitive: true }),
    description: z.string(),
    created: z.string(),
    expires: z.string(),
    revoked: z.string(),
    invalid: z.boolean(),
    capabilities: z
      .object({
        devices: z
          .object({
            create: z
              .object({
                reusable: z.boolean(),
                ephemeral: z.boolean(),
                preauthorized: z.boolean(),
                tags: z.array(z.string()),
              })
              .passthrough(),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

function normalizeKey(raw) {
  const caps = raw.capabilities || {};
  const devices = caps.devices || {};
  const create = devices.create || {};
  return {
    id: raw.id || "",
    key: raw.key || "",
    description: raw.description || "",
    created: raw.created || "",
    expires: raw.expires || "",
    revoked: raw.revoked || "",
    invalid: raw.invalid ?? false,
    capabilities: {
      devices: {
        create: {
          reusable: create.reusable ?? false,
          ephemeral: create.ephemeral ?? false,
          preauthorized: create.preauthorized ?? false,
          tags: create.tags || [],
        },
      },
    },
  };
}

export const model = {
  type: "@john/tailscale-auth-key",
  version: "2026.02.28.1",
  globalArguments: TailscaleGlobalArgsSchema,
  resources: {
    key: {
      description: "Tailscale auth key",
      schema: KeySchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    list: {
      description:
        "List all auth keys in the tailnet. Produces one resource instance per key (factory pattern).",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const tailnet = encodeURIComponent(g.tailnet);
        const resp = await tsApi(
          g,
          "GET",
          `/api/v2/tailnet/${tailnet}/keys`,
        );
        const keys = resp.keys || [];

        context.logger.info("Found {count} auth keys", {
          count: keys.length,
        });

        const handles = [];
        for (const raw of keys) {
          const key = normalizeKey(raw);
          const handle = await context.writeResource(
            "key",
            sanitizeInstanceName(key.id),
            key,
          );
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    get: {
      description: "Get an auth key by ID.",
      arguments: z.object({
        keyId: z.string().describe("Auth key ID"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const tailnet = encodeURIComponent(g.tailnet);
        const resp = await tsApi(
          g,
          "GET",
          `/api/v2/tailnet/${tailnet}/keys/${encodeURIComponent(args.keyId)}`,
        );
        const key = normalizeKey(resp);
        const handle = await context.writeResource(
          "key",
          sanitizeInstanceName(key.id),
          key,
        );
        return { dataHandles: [handle] };
      },
    },

    create: {
      description: "Create a new auth key.",
      arguments: z.object({
        description: z
          .string()
          .default("")
          .describe("Description for the key"),
        expirySeconds: z
          .number()
          .default(86400)
          .describe("Key expiry in seconds (default 24h)"),
        reusable: z
          .boolean()
          .default(false)
          .describe("Whether the key is reusable"),
        ephemeral: z
          .boolean()
          .default(false)
          .describe("Whether devices using this key are ephemeral"),
        preauthorized: z
          .boolean()
          .default(false)
          .describe("Whether devices are pre-authorized"),
        tags: z
          .array(z.string())
          .default([])
          .describe("Tags to assign to devices, e.g. ['tag:server']"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const tailnet = encodeURIComponent(g.tailnet);
        const body = {
          capabilities: {
            devices: {
              create: {
                reusable: args.reusable,
                ephemeral: args.ephemeral,
                preauthorized: args.preauthorized,
                tags: args.tags,
              },
            },
          },
          expirySeconds: args.expirySeconds,
          description: args.description,
        };
        const resp = await tsApi(
          g,
          "POST",
          `/api/v2/tailnet/${tailnet}/keys`,
          body,
        );
        const key = normalizeKey(resp);
        context.logger.info("Created auth key {keyId}", { keyId: key.id });
        const handle = await context.writeResource(
          "key",
          sanitizeInstanceName(key.id),
          key,
        );
        return { dataHandles: [handle] };
      },
    },

    delete: {
      description: "Delete an auth key.",
      arguments: z.object({
        keyId: z.string().describe("Auth key ID to delete"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const tailnet = encodeURIComponent(g.tailnet);
        await tsApi(
          g,
          "DELETE",
          `/api/v2/tailnet/${tailnet}/keys/${encodeURIComponent(args.keyId)}`,
        );
        context.logger.info("Deleted auth key {keyId}", {
          keyId: args.keyId,
        });
        return { dataHandles: [] };
      },
    },
  },
};
