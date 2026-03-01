import { z } from "npm:zod@4";
import { TailscaleGlobalArgsSchema, tsApi } from "./_helpers.ts";

const ContactSchema = z
  .object({
    email: z.string(),
    fallbackEmail: z.string(),
    needsVerification: z.boolean(),
  })
  .passthrough();

const ContactsSchema = z
  .object({
    account: ContactSchema,
    support: ContactSchema,
    security: ContactSchema,
  })
  .passthrough();

export const model = {
  type: "@john/tailscale-contact",
  version: "2026.02.28.1",
  globalArguments: TailscaleGlobalArgsSchema,
  resources: {
    contacts: {
      description: "Tailnet contact information (account, support, security)",
      schema: ContactsSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    get: {
      description: "Get tailnet contact information.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const tailnet = encodeURIComponent(g.tailnet);
        const resp = await tsApi(
          g,
          "GET",
          `/api/v2/tailnet/${tailnet}/contacts`,
        );
        const handle = await context.writeResource(
          "contacts",
          "current",
          resp,
        );
        return { dataHandles: [handle] };
      },
    },

    update: {
      description:
        "Update a contact email. A verification email will be sent if the address changes.",
      arguments: z.object({
        contactType: z
          .string()
          .describe("Contact type: 'account', 'support', or 'security'"),
        email: z.string().describe("New email address"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const tailnet = encodeURIComponent(g.tailnet);
        await tsApi(
          g,
          "PATCH",
          `/api/v2/tailnet/${tailnet}/contacts/${encodeURIComponent(args.contactType)}`,
          { email: args.email },
        );
        context.logger.info(
          "Updated {contactType} contact to {email}",
          { contactType: args.contactType, email: args.email },
        );
        const resp = await tsApi(
          g,
          "GET",
          `/api/v2/tailnet/${tailnet}/contacts`,
        );
        const handle = await context.writeResource(
          "contacts",
          "current",
          resp,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
