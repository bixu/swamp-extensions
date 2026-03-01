import { z } from "npm:zod@4";
import { WebClient } from "npm:@slack/web-api@7.14.1";
import Parser from "npm:rss-parser@3";
import { TailscaleGlobalArgsSchema, tsApi } from "./tailscale/_helpers.ts";

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

type Device = { hostname: string; version: string; owner: string };

function parseVersion(version: string): number[] | null {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isBelow(version: string, floor: string): boolean {
  const v = parseVersion(version);
  const f = parseVersion(floor);
  if (!v || !f) return false;
  for (let i = 0; i < 3; i++) {
    if (v[i] < f[i]) return true;
    if (v[i] > f[i]) return false;
  }
  return false;
}

function compareVersions(a: string, b: string): number {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return 0;
  for (let i = 0; i < 3; i++) {
    if (va[i] !== vb[i]) return va[i] - vb[i];
  }
  return 0;
}

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

function buildCsv(rawDevices: Record<string, unknown>[]): string {
  if (rawDevices.length === 0) return "";

  const escapeCsv = (v: unknown): string => {
    const s = Array.isArray(v) ? v.join("; ") : String(v ?? "");
    return s.includes(",") || s.includes('"') || s.includes("\n")
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };

  // Collect all keys, with priority columns first
  const priority = ["hostname", "user", "tags"];
  const keySet = new Set<string>();
  for (const d of rawDevices) {
    for (const k of Object.keys(d)) keySet.add(k);
  }
  const rest = [...keySet].filter((k) => !priority.includes(k)).sort();
  const keys = [...priority.filter((k) => keySet.has(k)), ...rest];

  const lines = [keys.join(",")];
  for (const d of rawDevices) {
    lines.push(keys.map((k) => escapeCsv(d[k])).join(","));
  }
  return lines.join("\n");
}

function buildOutdatedClientsMarkdown(
  devices: Device[],
  securityFloor: string,
): string {
  const lines: string[] = [];
  lines.push("## Tailscale Clients with Unpatched High/Critical Issues");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(
    `Minimum safe Tailscale version: ${securityFloor} (${SECURITY_BULLETIN_URL})`,
  );
  lines.push("");

  if (devices.length === 0) {
    lines.push("All devices are at or above the minimum safe version.");
  } else {
    lines.push("### Hosts Requiring Update");
    lines.push("");
    lines.push("| Hostname | Version | Owner |");
    lines.push("|----------|---------|-------|");
    for (const d of devices) {
      lines.push(`| ${d.hostname} | ${d.version} | ${d.owner} |`);
    }
    lines.push("");
    lines.push(`**${devices.length}** devices below minimum safe version`);
  }

  return lines.join("\n");
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
