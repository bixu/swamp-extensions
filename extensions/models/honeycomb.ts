import { z } from "npm:zod@4";
import {
  authHeadersV1,
  baseUrl,
  buildSummaryTable,
  connectionInfo,
  findByNameOrSlug,
  mapApiItem,
  mapV1Item,
  resolveV1Request,
  resourceUrl,
  V1_RESOURCE_REGISTRY,
  validateV1ConfigKey,
} from "./honeycomb_helpers.ts";

const GlobalArgsSchema = z.object({
  teamSlug: z.string().describe("Honeycomb team slug"),
  apiKeyId: z.string().describe("Honeycomb Management Key ID"),
  apiKeySecret: z.string().describe("Honeycomb Management Key secret"),
  region: z
    .enum(["us", "eu"])
    .default("us")
    .describe("Honeycomb region (us or eu)"),
  configKey: z.string().optional().describe(
    "Honeycomb Configuration Key (for v1 API resources)",
  ),
});

const ResourceSchema = z.object({
  id: z.string(),
  type: z.string(),
  attributes: z.any(),
});

const V1ResourceSchema = z.object({
  type: z.string(),
  attributes: z.any(),
});

const ResourceArg = z.object({
  resource: z.string().describe(
    "Honeycomb resource type (e.g. environments, datasets)",
  ),
  dataset: z.string().optional().describe(
    "Dataset slug (required for dataset-scoped resources, optional filter for datasets)",
  ),
  json: z.boolean().default(false).describe(
    "Output raw JSON instead of an ASCII table",
  ),
});

export const model = {
  type: "@bixu/honeycomb",
  version: "2026.03.02.14",
  globalArguments: GlobalArgsSchema,
  resources: {
    resource: {
      description: "Honeycomb v2 API resource",
      schema: ResourceSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    v1resource: {
      description: "Honeycomb v1 API resource",
      schema: V1ResourceSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    get: {
      description: "List all resources of a given type",
      arguments: ResourceArg,
      execute: async (args, context) => {
        const isV1 = args.resource in V1_RESOURCE_REGISTRY;

        if (isV1) {
          const configKey = context.globalArgs.configKey;
          if (!configKey) {
            throw new Error(
              `v1 resource "${args.resource}" requires configKey in globalArguments`,
            );
          }

          const trimmedKey = String(configKey).trim();
          validateV1ConfigKey(trimmedKey);

          const base = baseUrl(context.globalArgs.region);
          const url = resolveV1Request(
            base,
            args.resource,
            args.dataset,
          );
          const headers = authHeadersV1(trimmedKey);

          const resp = await fetch(url, { headers });
          if (!resp.ok) {
            const body = await resp.text();
            throw new Error(`Honeycomb API error ${resp.status}: ${body}`);
          }

          const json = await resp.json();

          const entry = V1_RESOURCE_REGISTRY[args.resource];
          const isSingleItem = entry.slugFilterable && args.dataset;

          // Normalize response into an array of items:
          // - Single item fetch (e.g. /1/datasets/{slug}): wrap in array
          // - Array response: use as-is
          // - Object response (e.g. dataset-definitions): convert entries
          let items: Array<Record<string, unknown>>;
          if (isSingleItem) {
            items = [json as Record<string, unknown>];
          } else if (Array.isArray(json)) {
            items = json;
          } else {
            items = Object.entries(json).map(([key, value]) => ({
              name: key,
              ...(typeof value === "object" && value !== null
                ? value as Record<string, unknown>
                : { value }),
            }));
          }

          const handles = [];
          const allItems = [];

          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            allItems.push(item);
            const mapped = mapV1Item(item, args.resource, i);
            const handle = await context.writeResource(
              "v1resource",
              mapped.instanceName,
              mapped.data,
            );
            handles.push(handle);
          }

          const output = args.json
            ? JSON.stringify(allItems, null, 2) + "\n"
            : buildSummaryTable(
              args.resource,
              allItems.map((item, i) => ({
                id: (item.slug as string) ?? (item.name as string) ??
                  `${args.resource}-${i}`,
                attributes: item,
              })),
            ).join("\n") + "\n";
          await Deno.stdout.write(new TextEncoder().encode(output));

          return { dataHandles: handles };
        }

        // v2 path (existing behavior)
        const { teamSlug, base, headers } = connectionInfo(
          context.globalArgs,
        );
        const collectionUrl = resourceUrl(base, teamSlug, args.resource);
        const handles = [];
        const allItems = [];
        let nextUrl: string | null = null;

        do {
          const url = nextUrl ?? collectionUrl;
          const resp = await fetch(url, { headers });

          if (!resp.ok) {
            const body = await resp.text();
            throw new Error(`Honeycomb API error ${resp.status}: ${body}`);
          }

          const json = await resp.json();

          for (const item of json.data) {
            allItems.push(item);
            const mapped = mapApiItem(item, args.resource);
            const handle = await context.writeResource(
              "resource",
              mapped.instanceName,
              mapped.data,
            );
            handles.push(handle);
          }

          const next = json.links?.next;
          nextUrl = next ? `${base}${next}` : null;
        } while (nextUrl);

        const output = args.json
          ? JSON.stringify(allItems, null, 2) + "\n"
          : buildSummaryTable(args.resource, allItems).join("\n") + "\n";
        await Deno.stdout.write(new TextEncoder().encode(output));

        return { dataHandles: handles };
      },
    },
    create: {
      description: "Create a new resource of a given type",
      arguments: ResourceArg.extend({
        name: z.string().describe("Name of the resource to create"),
      }),
      execute: async (args, context) => {
        const { teamSlug, base, headers } = connectionInfo(
          context.globalArgs,
        );
        const collectionUrl = resourceUrl(base, teamSlug, args.resource);

        const resp = await fetch(collectionUrl, {
          method: "POST",
          headers,
          body: JSON.stringify({
            data: {
              type: args.resource,
              attributes: { name: args.name },
            },
          }),
        });

        if (!resp.ok) {
          const body = await resp.text();
          throw new Error(`Honeycomb API error ${resp.status}: ${body}`);
        }

        const json = await resp.json();
        const mapped = mapApiItem(json.data, args.resource);

        const handle = await context.writeResource(
          "resource",
          mapped.instanceName,
          mapped.data,
        );

        return { dataHandles: [handle] };
      },
    },
    delete: {
      description: "Delete a resource by name or slug",
      arguments: ResourceArg.extend({
        name: z.string().describe("Name or slug of the resource to delete"),
      }),
      execute: async (args, context) => {
        const { teamSlug, base, headers } = connectionInfo(
          context.globalArgs,
        );
        const collectionUrl = resourceUrl(base, teamSlug, args.resource);

        const listResp = await fetch(collectionUrl, { headers });

        if (!listResp.ok) {
          const body = await listResp.text();
          throw new Error(`Honeycomb API error ${listResp.status}: ${body}`);
        }

        const listJson = await listResp.json();
        const target = findByNameOrSlug(listJson.data, args.name);

        if (!target) {
          throw new Error(
            `No ${args.resource} found matching "${args.name}"`,
          );
        }

        const deleteResp = await fetch(
          `${collectionUrl}/${encodeURIComponent(target.id)}`,
          { method: "DELETE", headers },
        );

        if (!deleteResp.ok) {
          const body = await deleteResp.text();
          throw new Error(`Honeycomb API error ${deleteResp.status}: ${body}`);
        }

        return { dataHandles: [] };
      },
    },
  },
};
