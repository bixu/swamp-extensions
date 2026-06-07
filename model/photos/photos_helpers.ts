import { join } from "jsr:@std/path@1";

export function buildAphexCommand(
  binaryPath: string,
  subcommand: string,
  args: string[],
): string[] {
  return [binaryPath, subcommand, ...args];
}

export function parseAphexOutput(stdout: string): Record<string, unknown>[] {
  const trimmed = stdout.trim();
  if (trimmed === "") return [];
  return JSON.parse(trimmed);
}

export function resolveExportDir(
  exportDir?: string,
  albumName?: string,
): string {
  if (exportDir) return exportDir;
  const tmpDir = Deno.env.get("TMPDIR") || "/tmp";
  const slug = (albumName || "photos").toLowerCase().replace(
    /[^a-z0-9]+/g,
    "-",
  );
  return join(tmpDir, `swamp-photos-${slug}`);
}
