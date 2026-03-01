import { z } from "npm:zod@4";
import {
  sanitizeInstanceName,
  TailscaleGlobalArgsSchema,
  tsApi,
} from "./_helpers.ts";

const DeviceSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    hostname: z.string(),
    addresses: z.array(z.string()),
    authorized: z.boolean(),
    user: z.string(),
    tags: z.array(z.string()),
    os: z.string(),
    clientVersion: z.string(),
    keyExpiryDisabled: z.boolean(),
    blocksIncomingConnections: z.boolean(),
    isExternal: z.boolean(),
    connectedToControl: z.boolean(),
    updateAvailable: z.boolean(),
    created: z.string(),
    expires: z.string(),
    lastSeen: z.string(),
    machineKey: z.string(),
    nodeKey: z.string(),
  })
  .passthrough();

const DeviceRoutesSchema = z
  .object({
    advertisedRoutes: z.array(z.string()),
    enabledRoutes: z.array(z.string()),
  })
  .passthrough();

const PostureAttributesSchema = z
  .object({
    attributes: z.record(z.string(), z.any()),
  })
  .passthrough();

function normalizeDevice(raw) {
  return {
    id: raw.id || "",
    name: raw.name || "",
    hostname: raw.hostname || "",
    addresses: raw.addresses || [],
    authorized: raw.authorized ?? false,
    user: raw.user || "",
    tags: raw.tags || [],
    os: raw.os || "",
    clientVersion: raw.clientVersion || "",
    keyExpiryDisabled: raw.keyExpiryDisabled ?? false,
    blocksIncomingConnections: raw.blocksIncomingConnections ?? false,
    isExternal: raw.isExternal ?? false,
    connectedToControl: raw.connectedToControl ?? false,
    updateAvailable: raw.updateAvailable ?? false,
    created: raw.created || "",
    expires: raw.expires || "",
    lastSeen: raw.lastSeen || "",
    machineKey: raw.machineKey || "",
    nodeKey: raw.nodeKey || "",
  };
}

export const model = {
  type: "@john/tailscale-device",
  version: "2026.02.28.1",
  globalArguments: TailscaleGlobalArgsSchema,
  resources: {
    device: {
      description: "Tailscale device",
      schema: DeviceSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    routes: {
      description: "Device subnet routes (advertised and enabled)",
      schema: DeviceRoutesSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    posture: {
      description: "Device posture attributes",
      schema: PostureAttributesSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    list: {
      description:
        "List all devices in the tailnet. Produces one resource instance per device (factory pattern).",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const tailnet = encodeURIComponent(g.tailnet);
        const resp = await tsApi(
          g,
          "GET",
          `/api/v2/tailnet/${tailnet}/devices`,
        );
        const devices = resp.devices || [];

        context.logger.info("Found {count} devices", {
          count: devices.length,
        });

        const handles = [];
        for (const raw of devices) {
          const device = normalizeDevice(raw);
          const handle = await context.writeResource(
            "device",
            sanitizeInstanceName(device.id),
            device,
          );
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    get: {
      description: "Get a single device by ID.",
      arguments: z.object({
        deviceId: z.string().describe("Device ID"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const resp = await tsApi(
          g,
          "GET",
          `/api/v2/device/${encodeURIComponent(args.deviceId)}`,
        );
        const device = normalizeDevice(resp);
        const handle = await context.writeResource(
          "device",
          sanitizeInstanceName(device.id),
          device,
        );
        return { dataHandles: [handle] };
      },
    },

    delete: {
      description: "Delete a device from the tailnet.",
      arguments: z.object({
        deviceId: z.string().describe("Device ID to delete"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        await tsApi(
          g,
          "DELETE",
          `/api/v2/device/${encodeURIComponent(args.deviceId)}`,
        );
        context.logger.info("Deleted device {deviceId}", {
          deviceId: args.deviceId,
        });
        return { dataHandles: [] };
      },
    },

    authorize: {
      description: "Authorize or deauthorize a device.",
      arguments: z.object({
        deviceId: z.string().describe("Device ID"),
        authorized: z
          .boolean()
          .describe("true to authorize, false to deauthorize"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        await tsApi(
          g,
          "POST",
          `/api/v2/device/${encodeURIComponent(args.deviceId)}/authorized`,
          { authorized: args.authorized },
        );
        context.logger.info("Set device {deviceId} authorized={authorized}", {
          deviceId: args.deviceId,
          authorized: args.authorized,
        });
        // Re-fetch to return updated state
        const resp = await tsApi(
          g,
          "GET",
          `/api/v2/device/${encodeURIComponent(args.deviceId)}`,
        );
        const device = normalizeDevice(resp);
        const handle = await context.writeResource(
          "device",
          sanitizeInstanceName(device.id),
          device,
        );
        return { dataHandles: [handle] };
      },
    },

    setTags: {
      description: "Set ACL tags on a device.",
      arguments: z.object({
        deviceId: z.string().describe("Device ID"),
        tags: z
          .array(z.string())
          .describe("Tags to set, e.g. ['tag:server', 'tag:prod']"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        await tsApi(
          g,
          "POST",
          `/api/v2/device/${encodeURIComponent(args.deviceId)}/tags`,
          { tags: args.tags },
        );
        context.logger.info("Set tags on device {deviceId}", {
          deviceId: args.deviceId,
        });
        const resp = await tsApi(
          g,
          "GET",
          `/api/v2/device/${encodeURIComponent(args.deviceId)}`,
        );
        const device = normalizeDevice(resp);
        const handle = await context.writeResource(
          "device",
          sanitizeInstanceName(device.id),
          device,
        );
        return { dataHandles: [handle] };
      },
    },

    setKey: {
      description:
        "Set key expiry properties on a device (enable/disable key expiry).",
      arguments: z.object({
        deviceId: z.string().describe("Device ID"),
        keyExpiryDisabled: z
          .boolean()
          .describe("true to disable key expiry, false to enable"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        await tsApi(
          g,
          "POST",
          `/api/v2/device/${encodeURIComponent(args.deviceId)}/key`,
          { keyExpiryDisabled: args.keyExpiryDisabled },
        );
        context.logger.info(
          "Set keyExpiryDisabled={disabled} on device {deviceId}",
          { disabled: args.keyExpiryDisabled, deviceId: args.deviceId },
        );
        const resp = await tsApi(
          g,
          "GET",
          `/api/v2/device/${encodeURIComponent(args.deviceId)}`,
        );
        const device = normalizeDevice(resp);
        const handle = await context.writeResource(
          "device",
          sanitizeInstanceName(device.id),
          device,
        );
        return { dataHandles: [handle] };
      },
    },

    setRoutes: {
      description: "Set subnet routes for a device.",
      arguments: z.object({
        deviceId: z.string().describe("Device ID"),
        routes: z
          .array(z.string())
          .describe("Subnet routes to enable, e.g. ['10.0.0.0/24']"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        await tsApi(
          g,
          "POST",
          `/api/v2/device/${encodeURIComponent(args.deviceId)}/routes`,
          { routes: args.routes },
        );
        context.logger.info("Set routes on device {deviceId}", {
          deviceId: args.deviceId,
        });
        const resp = await tsApi(
          g,
          "GET",
          `/api/v2/device/${encodeURIComponent(args.deviceId)}/routes`,
        );
        const handle = await context.writeResource(
          "routes",
          sanitizeInstanceName(args.deviceId),
          resp,
        );
        return { dataHandles: [handle] };
      },
    },

    getRoutes: {
      description: "Get advertised and enabled subnet routes for a device.",
      arguments: z.object({
        deviceId: z.string().describe("Device ID"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const resp = await tsApi(
          g,
          "GET",
          `/api/v2/device/${encodeURIComponent(args.deviceId)}/routes`,
        );
        const handle = await context.writeResource(
          "routes",
          sanitizeInstanceName(args.deviceId),
          resp,
        );
        return { dataHandles: [handle] };
      },
    },

    setName: {
      description: "Rename a device.",
      arguments: z.object({
        deviceId: z.string().describe("Device ID"),
        name: z.string().describe("New device name (FQDN)"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        await tsApi(
          g,
          "POST",
          `/api/v2/device/${encodeURIComponent(args.deviceId)}/name`,
          { name: args.name },
        );
        context.logger.info("Renamed device {deviceId} to {name}", {
          deviceId: args.deviceId,
          name: args.name,
        });
        const resp = await tsApi(
          g,
          "GET",
          `/api/v2/device/${encodeURIComponent(args.deviceId)}`,
        );
        const device = normalizeDevice(resp);
        const handle = await context.writeResource(
          "device",
          sanitizeInstanceName(device.id),
          device,
        );
        return { dataHandles: [handle] };
      },
    },

    setIPv4: {
      description: "Set the Tailscale IPv4 address of a device.",
      arguments: z.object({
        deviceId: z.string().describe("Device ID"),
        ipv4: z.string().describe("New IPv4 address"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        await tsApi(
          g,
          "POST",
          `/api/v2/device/${encodeURIComponent(args.deviceId)}/ip`,
          { ipv4: args.ipv4 },
        );
        context.logger.info("Set IPv4 {ipv4} on device {deviceId}", {
          ipv4: args.ipv4,
          deviceId: args.deviceId,
        });
        const resp = await tsApi(
          g,
          "GET",
          `/api/v2/device/${encodeURIComponent(args.deviceId)}`,
        );
        const device = normalizeDevice(resp);
        const handle = await context.writeResource(
          "device",
          sanitizeInstanceName(device.id),
          device,
        );
        return { dataHandles: [handle] };
      },
    },

    getPosture: {
      description: "Get posture attributes for a device.",
      arguments: z.object({
        deviceId: z.string().describe("Device ID"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const resp = await tsApi(
          g,
          "GET",
          `/api/v2/device/${encodeURIComponent(args.deviceId)}/attributes`,
        );
        const handle = await context.writeResource(
          "posture",
          sanitizeInstanceName(args.deviceId),
          resp,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
