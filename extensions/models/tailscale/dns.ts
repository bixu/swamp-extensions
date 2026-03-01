import { z } from "npm:zod@4";
import { TailscaleGlobalArgsSchema, tsApi } from "./_helpers.ts";

const NameserversSchema = z
  .object({
    dns: z.array(z.string()),
  })
  .passthrough();

const SearchPathsSchema = z
  .object({
    searchPaths: z.array(z.string()),
  })
  .passthrough();

const PreferencesSchema = z
  .object({
    magicDNS: z.boolean(),
  })
  .passthrough();

const SplitDnsSchema = z.record(z.string(), z.array(z.string()));

export const model = {
  type: "@john/tailscale-dns",
  version: "2026.02.28.1",
  globalArguments: TailscaleGlobalArgsSchema,
  resources: {
    nameservers: {
      description: "DNS nameservers configured for the tailnet",
      schema: NameserversSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    searchPaths: {
      description: "DNS search paths configured for the tailnet",
      schema: SearchPathsSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    preferences: {
      description: "DNS preferences (MagicDNS status)",
      schema: PreferencesSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    splitDns: {
      description: "Split DNS configuration (domain to nameserver mapping)",
      schema: SplitDnsSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    getNameservers: {
      description: "Get DNS nameservers for the tailnet.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const tailnet = encodeURIComponent(g.tailnet);
        const resp = await tsApi(
          g,
          "GET",
          `/api/v2/tailnet/${tailnet}/dns/nameservers`,
        );
        const handle = await context.writeResource(
          "nameservers",
          "current",
          resp,
        );
        return { dataHandles: [handle] };
      },
    },

    setNameservers: {
      description: "Set DNS nameservers for the tailnet.",
      arguments: z.object({
        dns: z
          .array(z.string())
          .describe("List of nameserver IPs, e.g. ['8.8.8.8', '1.1.1.1']"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const tailnet = encodeURIComponent(g.tailnet);
        await tsApi(
          g,
          "POST",
          `/api/v2/tailnet/${tailnet}/dns/nameservers`,
          { dns: args.dns },
        );
        context.logger.info("Set {count} nameservers", {
          count: args.dns.length,
        });
        const resp = await tsApi(
          g,
          "GET",
          `/api/v2/tailnet/${tailnet}/dns/nameservers`,
        );
        const handle = await context.writeResource(
          "nameservers",
          "current",
          resp,
        );
        return { dataHandles: [handle] };
      },
    },

    getSearchPaths: {
      description: "Get DNS search paths for the tailnet.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const tailnet = encodeURIComponent(g.tailnet);
        const resp = await tsApi(
          g,
          "GET",
          `/api/v2/tailnet/${tailnet}/dns/searchpaths`,
        );
        const handle = await context.writeResource(
          "searchPaths",
          "current",
          resp,
        );
        return { dataHandles: [handle] };
      },
    },

    setSearchPaths: {
      description: "Set DNS search paths for the tailnet.",
      arguments: z.object({
        searchPaths: z
          .array(z.string())
          .describe("List of search path domains"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const tailnet = encodeURIComponent(g.tailnet);
        await tsApi(
          g,
          "POST",
          `/api/v2/tailnet/${tailnet}/dns/searchpaths`,
          { searchPaths: args.searchPaths },
        );
        context.logger.info("Set {count} search paths", {
          count: args.searchPaths.length,
        });
        const resp = await tsApi(
          g,
          "GET",
          `/api/v2/tailnet/${tailnet}/dns/searchpaths`,
        );
        const handle = await context.writeResource(
          "searchPaths",
          "current",
          resp,
        );
        return { dataHandles: [handle] };
      },
    },

    getPreferences: {
      description: "Get DNS preferences (MagicDNS status).",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const tailnet = encodeURIComponent(g.tailnet);
        const resp = await tsApi(
          g,
          "GET",
          `/api/v2/tailnet/${tailnet}/dns/preferences`,
        );
        const handle = await context.writeResource(
          "preferences",
          "current",
          resp,
        );
        return { dataHandles: [handle] };
      },
    },

    setPreferences: {
      description: "Enable or disable MagicDNS.",
      arguments: z.object({
        magicDNS: z
          .boolean()
          .describe("true to enable MagicDNS, false to disable"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const tailnet = encodeURIComponent(g.tailnet);
        await tsApi(
          g,
          "POST",
          `/api/v2/tailnet/${tailnet}/dns/preferences`,
          { magicDNS: args.magicDNS },
        );
        context.logger.info("Set MagicDNS={enabled}", {
          enabled: args.magicDNS,
        });
        const handle = await context.writeResource(
          "preferences",
          "current",
          { magicDNS: args.magicDNS },
        );
        return { dataHandles: [handle] };
      },
    },

    getSplitDns: {
      description: "Get split DNS configuration.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const tailnet = encodeURIComponent(g.tailnet);
        const resp = await tsApi(
          g,
          "GET",
          `/api/v2/tailnet/${tailnet}/dns/split-dns`,
        );
        const handle = await context.writeResource(
          "splitDns",
          "current",
          resp || {},
        );
        return { dataHandles: [handle] };
      },
    },

    setSplitDns: {
      description: "Set split DNS configuration (full replace).",
      arguments: z.object({
        splitDns: z
          .record(z.string(), z.array(z.string()))
          .describe(
            "Domain-to-nameserver mapping, e.g. { 'example.com': ['10.0.0.1'] }",
          ),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const tailnet = encodeURIComponent(g.tailnet);
        await tsApi(
          g,
          "PUT",
          `/api/v2/tailnet/${tailnet}/dns/split-dns`,
          args.splitDns,
        );
        context.logger.info("Set split DNS configuration");
        const resp = await tsApi(
          g,
          "GET",
          `/api/v2/tailnet/${tailnet}/dns/split-dns`,
        );
        const handle = await context.writeResource(
          "splitDns",
          "current",
          resp || {},
        );
        return { dataHandles: [handle] };
      },
    },

    updateSplitDns: {
      description: "Partially update split DNS configuration.",
      arguments: z.object({
        splitDns: z
          .record(z.string(), z.array(z.string()).nullable())
          .describe(
            "Partial update: set domains to nameserver lists, or null to remove a domain",
          ),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const tailnet = encodeURIComponent(g.tailnet);
        const resp = await tsApi(
          g,
          "PATCH",
          `/api/v2/tailnet/${tailnet}/dns/split-dns`,
          args.splitDns,
        );
        context.logger.info("Updated split DNS configuration");
        const handle = await context.writeResource(
          "splitDns",
          "current",
          resp || {},
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
