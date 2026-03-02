type Device = { hostname: string; version: string; owner: string };

export type { Device };

export function parseVersion(version: string): number[] | null {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isBelow(version: string, floor: string): boolean {
  const v = parseVersion(version);
  const f = parseVersion(floor);
  if (!v || !f) return false;
  for (let i = 0; i < 3; i++) {
    if (v[i] < f[i]) return true;
    if (v[i] > f[i]) return false;
  }
  return false;
}

export function compareVersions(a: string, b: string): number {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return 0;
  for (let i = 0; i < 3; i++) {
    if (va[i] !== vb[i]) return va[i] - vb[i];
  }
  return 0;
}

export function buildCsv(rawDevices: Record<string, unknown>[]): string {
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

export const SECURITY_BULLETIN_URL = "https://tailscale.com/security-bulletins";

export function buildOutdatedClientsMarkdown(
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
