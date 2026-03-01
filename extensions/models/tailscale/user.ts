import { z } from "npm:zod@4";
import {
  TailscaleGlobalArgsSchema,
  tsApi,
  sanitizeInstanceName,
} from "./_helpers.ts";

const UserSchema = z
  .object({
    id: z.string(),
    displayName: z.string(),
    loginName: z.string(),
    profilePicUrl: z.string(),
    tailnetId: z.string(),
    created: z.string(),
    type: z.string(),
    role: z.string(),
    status: z.string(),
    lastSeen: z.string(),
    currentlyConnected: z.boolean(),
  })
  .passthrough();

function normalizeUser(raw) {
  return {
    id: raw.id || "",
    displayName: raw.displayName || "",
    loginName: raw.loginName || "",
    profilePicUrl: raw.profilePicUrl || "",
    tailnetId: raw.tailnetId || "",
    created: raw.created || "",
    type: raw.type || "",
    role: raw.role || "",
    status: raw.status || "",
    lastSeen: raw.lastSeen || "",
    currentlyConnected: raw.currentlyConnected ?? false,
  };
}

export const model = {
  type: "@john/tailscale-user",
  version: "2026.02.28.1",
  globalArguments: TailscaleGlobalArgsSchema,
  resources: {
    user: {
      description: "Tailscale user",
      schema: UserSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    list: {
      description:
        "List all users in the tailnet. Produces one resource instance per user (factory pattern).",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const tailnet = encodeURIComponent(g.tailnet);
        const resp = await tsApi(
          g,
          "GET",
          `/api/v2/tailnet/${tailnet}/users`,
        );
        const users = resp.users || [];

        context.logger.info("Found {count} users", { count: users.length });

        const handles = [];
        for (const raw of users) {
          const user = normalizeUser(raw);
          const handle = await context.writeResource(
            "user",
            sanitizeInstanceName(user.id),
            user,
          );
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    get: {
      description: "Get a single user by ID.",
      arguments: z.object({
        userId: z.string().describe("User ID"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const resp = await tsApi(
          g,
          "GET",
          `/api/v2/users/${encodeURIComponent(args.userId)}`,
        );
        const user = normalizeUser(resp);
        const handle = await context.writeResource(
          "user",
          sanitizeInstanceName(user.id),
          user,
        );
        return { dataHandles: [handle] };
      },
    },

    approve: {
      description: "Approve a pending user.",
      arguments: z.object({
        userId: z.string().describe("User ID to approve"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        await tsApi(
          g,
          "POST",
          `/api/v2/users/${encodeURIComponent(args.userId)}/approve`,
        );
        context.logger.info("Approved user {userId}", {
          userId: args.userId,
        });
        const resp = await tsApi(
          g,
          "GET",
          `/api/v2/users/${encodeURIComponent(args.userId)}`,
        );
        const user = normalizeUser(resp);
        const handle = await context.writeResource(
          "user",
          sanitizeInstanceName(user.id),
          user,
        );
        return { dataHandles: [handle] };
      },
    },

    suspend: {
      description: "Suspend a user.",
      arguments: z.object({
        userId: z.string().describe("User ID to suspend"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        await tsApi(
          g,
          "POST",
          `/api/v2/users/${encodeURIComponent(args.userId)}/suspend`,
        );
        context.logger.info("Suspended user {userId}", {
          userId: args.userId,
        });
        const resp = await tsApi(
          g,
          "GET",
          `/api/v2/users/${encodeURIComponent(args.userId)}`,
        );
        const user = normalizeUser(resp);
        const handle = await context.writeResource(
          "user",
          sanitizeInstanceName(user.id),
          user,
        );
        return { dataHandles: [handle] };
      },
    },

    restore: {
      description: "Restore a suspended user.",
      arguments: z.object({
        userId: z.string().describe("User ID to restore"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        await tsApi(
          g,
          "POST",
          `/api/v2/users/${encodeURIComponent(args.userId)}/restore`,
        );
        context.logger.info("Restored user {userId}", {
          userId: args.userId,
        });
        const resp = await tsApi(
          g,
          "GET",
          `/api/v2/users/${encodeURIComponent(args.userId)}`,
        );
        const user = normalizeUser(resp);
        const handle = await context.writeResource(
          "user",
          sanitizeInstanceName(user.id),
          user,
        );
        return { dataHandles: [handle] };
      },
    },

    delete: {
      description: "Delete a user from the tailnet.",
      arguments: z.object({
        userId: z.string().describe("User ID to delete"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        await tsApi(
          g,
          "DELETE",
          `/api/v2/users/${encodeURIComponent(args.userId)}`,
        );
        context.logger.info("Deleted user {userId}", {
          userId: args.userId,
        });
        return { dataHandles: [] };
      },
    },

    setRole: {
      description:
        "Update a user's role (owner, admin, it-admin, network-admin, member, auditor).",
      arguments: z.object({
        userId: z.string().describe("User ID"),
        role: z
          .string()
          .describe(
            "New role: owner, admin, it-admin, network-admin, member, or auditor",
          ),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        await tsApi(
          g,
          "POST",
          `/api/v2/users/${encodeURIComponent(args.userId)}/role`,
          { role: args.role },
        );
        context.logger.info("Set role {role} on user {userId}", {
          role: args.role,
          userId: args.userId,
        });
        const resp = await tsApi(
          g,
          "GET",
          `/api/v2/users/${encodeURIComponent(args.userId)}`,
        );
        const user = normalizeUser(resp);
        const handle = await context.writeResource(
          "user",
          sanitizeInstanceName(user.id),
          user,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
