import { z } from "npm:zod@4";
import { WebClient } from "npm:@slack/web-api@7.14.1";
import Parser from "npm:rss-parser@3";
import { TailscaleGlobalArgsSchema, tsApi } from "./tailscale/_helpers.ts";
import {
  type Device,
  buildCsv,
  buildOutdatedClientsMarkdown,
  compareVersions,
  isBelow,
} from "./tailnet_healthcheck_helpers.ts";

// Fallback minimum safe client version, used when the dynamic lookup of
// Tailscale security bulletins fails.
//
// TS-2026-001 (High, 2026-01-15) — tssentinelId command injection
//   Affected: macOS 1.84.0–1.92.3 — Fixed in: 1.94.0
const DEFAULT_SECURITY_FLOOR = "1.94.0";
const SECURITY_BULLETIN_URL = "https://tailscale.com/security-bulletins";
const SECURITY_BULLETIN_RSS =
  "https://tailscale.com/security-bulletins/index.xml";

const GlobalArgsSchema = TailscaleGlobalArgsSchema.extend({
  slackChannel: z
    .string()
    .optional()
    .describe("If set, auto-send the report to this Slack channel"),
  slackToken: z
    .string()
    .optional()
    .describe("Slack bot token (required if slackChannel is set)"),
});

const OutdatedClientsSchema = z.object({
  generatedAt: z.string(),
  securityFloor: z.string(),
  securityFloorSource: z.string(),
  devices: z.array(
    z.object({
      hostname: z.string(),
      version: z.string(),
      owner: z.string(),
    }),
  ),
  markdown: z.string(),
});

/**
 * Fetch the Tailscale security bulletins RSS feed and find the highest
 * "fixed in" client version across all bulletins that require a client update.
 * Returns null if the feed can't be fetched or parsed.
 */
async function fetchSecurityFloor(
  logger: { info: (msg: string, props?: Record<string, unknown>) => void },
): Promise<string | null> {
  const parser = new Parser();
  const feed = await parser.parseURL(SECURITY_BULLETIN_RSS);

  let highest: string | null = null;

  for (const item of feed.items) {
    const desc = item.contentSnippet || item.content || "";

    // Skip bulletins that are server-side only (no client update needed)
    if (/no action is required/i.test(desc)) continue;

    // Extract "fixed in" / "update to" version numbers
    const versionMatches = desc.match(
      /(?:fixed in|update to|upgrade to)[^.]*?(\d+\.\d+\.\d+)/gi,
    );
    if (!versionMatches) continue;

    for (const m of versionMatches) {
      const verMatch = m.match(/(\d+\.\d+\.\d+)/);
      if (!verMatch) continue;
      const ver = verMatch[1];
      if (!highest || compareVersions(ver, highest) > 0) {
        highest = ver;
      }
    }
  }

  if (highest) {
    logger.info("Fetched security floor {floor} from RSS feed", {
      floor: highest,
    });
  }

  return highest;
}

export const model = {
  type: "@bixu/tailnet-healthcheck",
  version: "2026.03.01.5",
  globalArguments: GlobalArgsSchema,
  resources: {
    outdatedClients: {
      description:
        "Devices running Tailscale client versions below the minimum safe version",
      schema: OutdatedClientsSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    run: {
      description:
        "Run a tailnet health report by type and optionally send to Slack",
      arguments: z.object({
        reportType: z
          .enum(["outdated-client"])
          .describe("Type of health report to generate"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const tailnet = encodeURIComponent(g.tailnet);

        // Determine security floor: try RSS feed, fall back to constant
        let securityFloor: string;
        let floorSource: string;
        try {
          const dynamic = await fetchSecurityFloor(context.logger);
          if (dynamic) {
            securityFloor = dynamic;
            floorSource = "rss";
          } else {
            securityFloor = DEFAULT_SECURITY_FLOOR;
            floorSource = "default";
            context.logger.info(
              "RSS feed returned no floor, using default {floor}",
              { floor: securityFloor },
            );
          }
        } catch {
          securityFloor = DEFAULT_SECURITY_FLOOR;
          floorSource = "default";
          context.logger.info(
            "Failed to fetch RSS feed, using default floor {floor}",
            { floor: securityFloor },
          );
        }

        // Fetch all devices (shared across all report types)
        const resp = await tsApi(
          g,
          "GET",
          `/api/v2/tailnet/${tailnet}/devices`,
        );
        const devices = resp.devices || [];

        context.logger.info("Fetched {count} devices for healthcheck", {
          count: devices.length,
        });

        let handle;
        let markdown = "";
        let outdatedDevices: Device[] = [];
        let outdatedRaw: Record<string, unknown>[] = [];

        switch (args.reportType) {
          case "outdated-client": {
            for (const raw of devices) {
              const v = raw.clientVersion || "";
              if (v && isBelow(v, securityFloor)) {
                outdatedDevices.push({
                  hostname: raw.hostname || raw.name || "",
                  version: v,
                  owner: raw.user || "",
                });
                outdatedRaw.push(raw);
              }
            }
            // Sort both arrays by hostname
            const sortIndices = outdatedDevices
              .map((d, i) => ({ hostname: d.hostname, i }))
              .sort((a, b) => a.hostname.localeCompare(b.hostname))
              .map((x) => x.i);
            outdatedDevices = sortIndices.map((i) => outdatedDevices[i]);
            outdatedRaw = sortIndices.map((i) => outdatedRaw[i]);

            markdown = buildOutdatedClientsMarkdown(
              outdatedDevices,
              securityFloor,
            );

            handle = await context.writeResource("outdatedClients", "latest", {
              generatedAt: new Date().toISOString(),
              securityFloor,
              securityFloorSource: floorSource,
              devices: outdatedDevices,
              markdown,
            });

            context.logger.info(
              "{count} devices below minimum safe version {floor} (source: {source})",
              {
                count: outdatedDevices.length,
                floor: securityFloor,
                source: floorSource,
              },
            );
            break;
          }
        }

        // Optionally send to Slack as a thread
        if (g.slackChannel && g.slackToken && handle) {
          const channel = g.slackChannel.replace(/^#/, "");
          const client = new WebClient(String(g.slackToken).trim());

          // Post parent message
          const parent = await client.chat.postMessage({
            channel,
            text: "Tailscale Clients with Unpatched High/Critical Issues",
          });

          if (!parent.ok) {
            throw new Error(`Slack API error: ${parent.error}`);
          }

          const threadTs = parent.ts!;

          // First reply: link to security bulletins
          const bulletinReply = await client.chat.postMessage({
            channel,
            thread_ts: threadTs,
            text:
              `Devices below minimum safe Tailscale version *${securityFloor}*\n` +
              `See: ${SECURITY_BULLETIN_URL}`,
          });

          if (!bulletinReply.ok) {
            throw new Error(`Slack API error: ${bulletinReply.error}`);
          }

          // Upload CSV as a file in the thread, fall back to local file
          if (outdatedDevices.length > 0) {
            const csv = buildCsv(outdatedRaw);
            const date = new Date().toISOString().slice(0, 10);
            const filename = `unpatched-tailscale-clients-${date}.csv`;

            try {
              await client.filesUploadV2({
                channel_id: parent.channel!,
                thread_ts: threadTs,
                filename,
                content: csv,
                title: `Unpatched Tailscale Clients (${outdatedDevices.length} devices)`,
              });

              context.logger.info("Uploaded CSV to Slack #{channel}", {
                channel,
              });
            } catch (err) {
              const localPath = `./${filename}`;
              await Deno.writeTextFile(localPath, csv);

              context.logger.info(
                "Slack file upload failed, wrote CSV to {path}: {error}",
                {
                  path: localPath,
                  error: String(err),
                },
              );
            }
          }

          context.logger.info("Sent report thread to Slack #{channel}", {
            channel,
          });
        }

        return { dataHandles: [handle] };
      },
    },
  },
};
