import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  teamSlug: z.string().describe("Honeycomb team slug"),
  apiKeyId: z.string().describe("Honeycomb Management Key ID"),
  apiKeySecret: z.string().describe("Honeycomb Management Key secret"),
  region: z
    .enum(["us", "eu"])
    .default("us")
    .describe("Honeycomb region (us or eu)"),
});

const EnvironmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  slug: z.string(),
  color: z.string(),
  deleteProtected: z.boolean(),
});

export const model = {
  type: "@bixu/honeycomb-environment",
  version: "2026.02.26.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    environment: {
      description: "Honeycomb environment details",
      schema: EnvironmentSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    sync: {
      description: "List all environments and store each as a resource",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const teamSlug = String(context.globalArgs.teamSlug).trim();
        const apiKeyId = String(context.globalArgs.apiKeyId).trim();
        const apiKeySecret = String(context.globalArgs.apiKeySecret).trim();
        const region = context.globalArgs.region;
        const baseUrl = region === "eu"
          ? "https://api.eu1.honeycomb.io"
          : "https://api.honeycomb.io";

        const handles = [];
        let nextUrl: string | null = null;

        do {
          const url = nextUrl ??
            `${baseUrl}/2/teams/${teamSlug}/environments`;

          const resp = await fetch(url, {
            headers: {
              Authorization: `Bearer ${apiKeyId}:${apiKeySecret}`,
              Accept: "application/vnd.api+json",
            },
          });

          if (!resp.ok) {
            const body = await resp.text();
            throw new Error(
              `Honeycomb API error ${resp.status}: ${body}`,
            );
          }

          const json = await resp.json();

          for (const env of json.data) {
            const handle = await context.writeResource(
              "environment",
              env.attributes.slug,
              {
                id: env.id,
                name: env.attributes.name,
                description: env.attributes.description,
                slug: env.attributes.slug,
                color: env.attributes.color,
                deleteProtected: env.attributes.settings.delete_protected,
              },
            );
            handles.push(handle);
          }

          const next = json.links?.next;
          nextUrl = next ? `${baseUrl}${next}` : null;
        } while (nextUrl);

        return { dataHandles: handles };
      },
    },
    get: {
      description: "Get a single environment by ID",
      arguments: z.object({
        environmentId: z.string().describe("The environment ID to fetch"),
      }),
      execute: async (args, context) => {
        const { teamSlug, apiKeyId, apiKeySecret, region } = context.globalArgs;
        const baseUrl = region === "eu"
          ? "https://api.eu1.honeycomb.io"
          : "https://api.honeycomb.io";

        const resp = await fetch(
          `${baseUrl}/2/teams/${encodeURIComponent(teamSlug)}/environments/${
            encodeURIComponent(args.environmentId)
          }`,
          {
            headers: {
              Authorization: `Bearer ${apiKeyId}:${apiKeySecret}`,
            },
          },
        );

        if (!resp.ok) {
          const body = await resp.text();
          throw new Error(
            `Honeycomb API error ${resp.status}: ${body}`,
          );
        }

        const json = await resp.json();
        const env = json.data;

        const handle = await context.writeResource(
          "environment",
          env.attributes.slug,
          {
            id: env.id,
            name: env.attributes.name,
            description: env.attributes.description,
            slug: env.attributes.slug,
            color: env.attributes.color,
            deleteProtected: env.attributes.settings.delete_protected,
          },
        );

        return { dataHandles: [handle] };
      },
    },
  },
};
