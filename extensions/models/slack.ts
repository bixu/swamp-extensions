import { z } from "npm:zod@4";
import { WebClient } from "npm:@slack/web-api@7.14.1";

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

export function formatTable(tableBlock: string): string {
  const lines = tableBlock.trim().split("\n");
  // Remove separator rows (|---|---|)
  const dataLines = lines.filter((l) => !/^\|[\s-:|]+\|$/.test(l));
  // Parse cells
  const rows = dataLines.map((l) =>
    l.split("|").slice(1, -1).map((c) => c.trim())
  );
  if (rows.length === 0) return tableBlock;

  // Calculate column widths
  const colCount = rows[0].length;
  const widths = Array.from(
    { length: colCount },
    (_, c) => Math.max(...rows.map((r) => (r[c] || "").length)),
  );

  // Format as aligned plain text
  const formatted = rows.map((r) =>
    r.map((cell, c) => cell.padEnd(widths[c])).join("  ")
  );

  // First row is header — add underline
  const header = formatted[0];
  const underline = widths.map((w) => "─".repeat(w)).join("  ");
  const body = formatted.slice(1).join("\n");

  return "```\n" + header + "\n" + underline + "\n" + body + "\n```";
}

export function markdownToSlackMrkdwn(md: string): string {
  const codeBlocks: string[] = [];
  let text = md;

  // Preserve fenced code blocks
  text = text.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match);
    return `__CODE_BLOCK_${codeBlocks.length - 1}__`;
  });

  // Preserve inline code
  const inlineCode: string[] = [];
  text = text.replace(/`[^`]+`/g, (match) => {
    inlineCode.push(match);
    return `__INLINE_CODE_${inlineCode.length - 1}__`;
  });

  // Convert markdown tables to formatted code blocks
  text = text.replace(
    /((?:^\|.+\|$\n?)+)/gm,
    (tableBlock) => formatTable(tableBlock),
  );

  // Headings → bold
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");

  // Bold **text** → *text* (avoid doubling stars on already-converted headings)
  text = text.replace(/\*\*(.+?)\*\*/g, "*$1*");

  // Links [text](url) → <url|text>
  text = text.replace(/\[(.+?)\]\((.+?)\)/g, "<$2|$1>");

  // Restore inline code
  text = text.replace(
    /__INLINE_CODE_(\d+)__/g,
    (_, i) => inlineCode[Number(i)],
  );

  // Restore code blocks
  text = text.replace(/__CODE_BLOCK_(\d+)__/g, (_, i) => codeBlocks[Number(i)]);

  return text;
}

export function splitIntoBlocks(
  text: string,
  limit = 3000,
): Record<string, unknown>[] {
  if (text.length <= limit) {
    return [{ type: "section", text: { type: "mrkdwn", text } }];
  }

  // Split on section boundaries (bold headings produced from ## headings)
  // to avoid breaking code blocks mid-stream
  const sections: string[] = [];
  let current = "";

  for (const line of text.split("\n")) {
    // A bold heading line like *Summary* marks a new section
    if (/^\*[^*]+\*$/.test(line.trim()) && current.trim()) {
      sections.push(current);
      current = line + "\n";
    } else {
      current += line + "\n";
    }
  }
  if (current.trim()) {
    sections.push(current);
  }

  // Break oversized sections by splitting code blocks (```...```) into
  // smaller fenced chunks that each fit within the limit.
  const expanded: string[] = [];
  for (const section of sections) {
    if (section.length <= limit) {
      expanded.push(section);
      continue;
    }
    // Extract code blocks and split their contents
    const parts = section.split(/(```[\s\S]*?```)/g);
    for (const part of parts) {
      if (!part.startsWith("```") || part.length <= limit) {
        if (part.trim()) expanded.push(part);
        continue;
      }
      // Split the code block's inner lines into smaller fenced blocks
      const inner = part.slice(3, -3).trim().split("\n");
      // Keep the header line (first row) to repeat in continuation blocks
      const headerLine = inner[0];
      let codeChunk = "```\n" + headerLine + "\n";
      for (let i = 1; i < inner.length; i++) {
        const nextLine = inner[i] + "\n";
        if (codeChunk.length + nextLine.length + 3 > limit) {
          codeChunk += "```";
          expanded.push(codeChunk);
          codeChunk = "```\n" + headerLine + "\n" + nextLine;
        } else {
          codeChunk += nextLine;
        }
      }
      if (codeChunk.length > 7) { // more than just ```\n```
        codeChunk += "```";
        expanded.push(codeChunk);
      }
    }
  }

  // Merge sections into blocks that fit within the limit
  const blocks: Record<string, unknown>[] = [];
  let chunk = "";

  for (const section of expanded) {
    if (chunk.length + section.length > limit && chunk.trim()) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: chunk.trimEnd() },
      });
      chunk = "";
    }
    chunk += section;
  }
  if (chunk.trim()) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: chunk.trimEnd() },
    });
  }

  return blocks;
}

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
