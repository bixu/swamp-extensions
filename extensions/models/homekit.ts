import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  discoveryTimeout: z.number().default(10).describe(
    "Seconds to wait for mDNS discovery (default: 10)",
  ),
  denoPath: z.string().default("deno").describe(
    "Path to deno binary (default: deno from PATH)",
  ),
});

const CategoryNames: Record<number, string> = {
  1: "Other",
  2: "Bridge",
  3: "Fan",
  4: "Garage Door Opener",
  5: "Lightbulb",
  6: "Door Lock",
  7: "Outlet",
  8: "Switch",
  9: "Thermostat",
  10: "Sensor",
  11: "Security System",
  12: "Door",
  13: "Window",
  14: "Window Covering",
  15: "Programmable Switch",
  16: "Range Extender",
  17: "IP Camera",
  18: "Video Doorbell",
  19: "Air Purifier",
  20: "Heater",
  21: "Air Conditioner",
  22: "Humidifier",
  23: "Dehumidifier",
  28: "Sprinkler",
  29: "Faucet",
  30: "Shower",
  32: "Television",
  33: "Remote Control",
  34: "Router",
};

const AccessorySchema = z.object({
  name: z.string(),
  address: z.string(),
  port: z.number(),
  id: z.string(),
  model: z.string(),
  category: z.string(),
  categoryId: z.number(),
  configNumber: z.number(),
  stateNumber: z.number(),
  protocolVersion: z.string(),
  paired: z.boolean(),
  discoveredAt: z.string(),
});

const DiscoverySchema = z.object({
  totalAccessories: z.number(),
  timeoutSeconds: z.number(),
  accessories: z.array(AccessorySchema),
  discoveredAt: z.string(),
});

const SummarySchema = z.object({
  method: z.string(),
  totalAccessories: z.number(),
  summary: z.string(),
  details: z.record(z.string(), z.union([z.string(), z.number()])),
  generatedAt: z.string(),
});

async function runDiscovery(denoPath, scriptPath, timeout) {
  const cmd = new Deno.Command(denoPath, {
    args: ["run", "--allow-all", scriptPath, String(timeout)],
    stdout: "piped",
    stderr: "piped",
  });
  const result = await cmd.output();
  const stderr = new TextDecoder().decode(result.stderr);
  if (!result.success) {
    throw new Error(`HomeKit discovery failed: ${stderr}`);
  }
  const stdout = new TextDecoder().decode(result.stdout).trim();
  return JSON.parse(stdout);
}

export const model = {
  type: "@bixu/homekit",
  version: "2026.03.14.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    discovery: {
      description: "Discovered HomeKit accessories on the local network",
      schema: DiscoverySchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    accessory: {
      description: "Individual HomeKit accessory",
      schema: AccessorySchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
    summary: {
      description: "Summary of a discovery operation",
      schema: SummarySchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    discover: {
      description: "Discover HomeKit accessories on the local network via mDNS",
      arguments: z.object({
        timeout: z.number().optional().describe(
          "Override discovery timeout in seconds",
        ),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const timeout = args.timeout ?? g.discoveryTimeout;

        const scriptPath =
          `${context.repoDir}/extensions/scripts/homekit_discover.ts`;

        context.logger.info("Starting HomeKit mDNS discovery ({timeout}s)", {
          timeout,
        });

        const raw = await runDiscovery(g.denoPath, scriptPath, timeout);

        const accessories = raw.map((d) => ({
          name: String(d.name || "Unknown"),
          address: String(d.address || ""),
          port: Number(d.port || 0),
          id: String(d.id || ""),
          model: String(d.md || "Unknown"),
          category: CategoryNames[d.ci] || `Unknown (${d.ci})`,
          categoryId: Number(d.ci || 0),
          configNumber: Number(d["c#"] || 0),
          stateNumber: Number(d["s#"] || 0),
          protocolVersion: String(d.pv || ""),
          paired: d.sf === 0,
          discoveredAt: new Date().toISOString(),
        }));

        const handles = [];

        for (const acc of accessories) {
          const handle = await context.writeResource(
            "accessory",
            acc.id.replace(/:/g, "-"),
            acc,
          );
          handles.push(handle);
        }

        const discoveryHandle = await context.writeResource(
          "discovery",
          "latest",
          {
            totalAccessories: accessories.length,
            timeoutSeconds: timeout,
            accessories,
            discoveredAt: new Date().toISOString(),
          },
        );

        const categoryCounts: Record<string, number> = {};
        for (const acc of accessories) {
          categoryCounts[acc.category] = (categoryCounts[acc.category] || 0) +
            1;
        }
        const categoryParts = Object.entries(categoryCounts)
          .map(([cat, n]) => `${cat}: ${n}`)
          .join(", ");
        const pairedCount = accessories.filter((a) => a.paired).length;

        const summaryHandle = await context.writeResource(
          "summary",
          "discover",
          {
            method: "discover",
            totalAccessories: accessories.length,
            summary:
              `${accessories.length} accessories found — ${categoryParts} | ${pairedCount} paired`,
            details: {
              ...categoryCounts,
              paired: pairedCount,
              unpaired: accessories.length - pairedCount,
            },
            generatedAt: new Date().toISOString(),
          },
        );

        return { dataHandles: [summaryHandle, discoveryHandle, ...handles] };
      },
    },
  },
};
