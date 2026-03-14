import { z } from "npm:zod@4";
import bonjourModule from "npm:bonjour-service@1.3.0";

// deno-lint-ignore no-explicit-any
const Bonjour = (bonjourModule as any).default || bonjourModule;

const HAP_SERVICE_TYPE = "hap";

const GlobalArgsSchema = z.object({
  discoveryTimeout: z.number().default(10).describe(
    "Seconds to wait for mDNS discovery (default: 10)",
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

function discoverAccessories(
  timeout: number,
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve) => {
    const bonjour = new Bonjour();
    const found: Record<string, unknown>[] = [];

    const browser = bonjour.find(
      { type: HAP_SERVICE_TYPE, protocol: "tcp" },
      // deno-lint-ignore no-explicit-any
      (service: any) => {
        found.push({
          name: service.name,
          host: service.host,
          port: service.port,
          addresses: service.addresses,
          txt: service.txt,
        });
      },
    );

    setTimeout(() => {
      browser.stop();
      bonjour.destroy();
      resolve(found);
    }, timeout * 1000);
  });
}

export const model = {
  type: "@bixu/homekit",
  version: "2026.03.14.2",
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

        context.logger.info("Starting HomeKit mDNS discovery ({timeout}s)", {
          timeout,
        });

        const raw = await discoverAccessories(timeout);

        // deno-lint-ignore no-explicit-any
        const accessories = raw.map((d: any) => {
          const txt = d.txt || {};
          const ci = Number(txt.ci || 0);
          return {
            name: String(d.name || "Unknown"),
            address: ((d.addresses as string[]) || []).find((a: string) =>
              a.includes(".")
            ) || String(d.host || ""),
            port: Number(d.port || 0),
            id: String(txt.id || ""),
            model: String(txt.md || "Unknown"),
            category: CategoryNames[ci] || `Unknown (${ci})`,
            categoryId: ci,
            configNumber: Number(txt["c#"] || 0),
            stateNumber: Number(txt["s#"] || 0),
            protocolVersion: String(txt.pv || ""),
            paired: txt.sf === "0" || txt.sf === 0,
            discoveredAt: new Date().toISOString(),
          };
        });

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
