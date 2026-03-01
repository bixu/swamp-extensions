import { z } from "npm:zod@4";
import { WebClient } from "npm:@slack/web-api@7.14.1";
import {
  formatTable,
  markdownToSlackMrkdwn,
  splitIntoBlocks,
} from "./slack_helpers.ts";

export { formatTable, markdownToSlackMrkdwn, splitIntoBlocks };

const GlobalArgsSchema = z.object({
  slackOauthToken: z
    .string()
    .describe("Slack Bot OAuth token (xoxb-...). Requires chat:write scope"),
});

const ResultSchema = z.object({
  ok: z.boolean(),
  channel: z.string(),
  ts: z.string(),
  permalink: z.string(),
});

export const model = {
  type: "@bixu/slack",
  version: "2026.03.01.2",
  globalArguments: GlobalArgsSchema,
  resources: {
    result: {
      description: "Message post confirmation",
      schema: ResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    send: {
      description: "Send a Markdown message to a Slack channel",
      arguments: z.object({
        channel: z.string().describe(
          "Channel name (with or without #) or channel ID",
        ),
        text: z.string().describe("Message content in standard Markdown"),
        title: z.string().optional().describe(
          "Optional title prepended as a bold header",
        ),
      }),
      execute: async (args, context) => {
        const botToken = String(context.globalArgs.slackOauthToken).trim();
        const channel = args.channel.replace(/^#/, "");
        const client = new WebClient(botToken);

        let mrkdwn = markdownToSlackMrkdwn(args.text);
        if (args.title) {
          mrkdwn = `*${args.title}*\n\n${mrkdwn}`;
        }

        const blocks = splitIntoBlocks(mrkdwn);

        // Truncate fallback text for notifications (Slack limit)
        const fallbackText = mrkdwn.length > 3000
          ? mrkdwn.slice(0, 2997) + "..."
          : mrkdwn;

        const result = await client.chat.postMessage({
          channel,
          text: fallbackText,
          blocks,
        });

        if (!result.ok) {
          throw new Error(`Slack API error: ${result.error}`);
        }

        context.logger.info(`Sent message to ${channel}`, { channel });

        // Fetch permalink
        let permalink = "";
        const plResult = await client.chat.getPermalink({
          channel: result.channel!,
          message_ts: result.ts!,
        });
        if (plResult.ok) {
          permalink = plResult.permalink || "";
        }

        const handle = await context.writeResource("result", "latest", {
          ok: result.ok,
          channel: result.channel || "",
          ts: result.ts || "",
          permalink,
        });

        return { dataHandles: [handle] };
      },
    },
  },
};
