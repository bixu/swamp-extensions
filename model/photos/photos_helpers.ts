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

export interface SipsResult {
  outputPath: string;
  width: number;
  height: number;
  fileSizeBytes: number;
  format: string;
}

export async function processWithSips(
  inputPath: string,
  outputDir: string,
  opts: { maxWidth: number; format: string; quality: number },
): Promise<SipsResult> {
  const ext = opts.format === "jpeg" ? "jpeg" : opts.format;
  const basename = inputPath.split("/").pop()!.replace(/\.[^.]+$/, `.${ext}`);
  const outputPath = join(outputDir, basename);

  const sipsArgs = [
    "-s",
    "format",
    opts.format === "jpeg" ? "jpeg" : opts.format,
    "--resampleWidth",
    String(opts.maxWidth),
    inputPath,
    "--out",
    outputPath,
  ];

  if (opts.format === "jpeg") {
    sipsArgs.push("-s", "formatOptions", String(opts.quality));
  }

  const proc = new Deno.Command("sips", {
    args: sipsArgs,
    stdout: "piped",
    stderr: "piped",
  });
  const result = await proc.output();
  if (!result.success) {
    const stderr = new TextDecoder().decode(result.stderr);
    throw new Error(`sips failed: ${stderr}`);
  }

  const infoProc = new Deno.Command("sips", {
    args: ["-g", "pixelWidth", "-g", "pixelHeight", outputPath],
    stdout: "piped",
    stderr: "piped",
  });
  const infoResult = await infoProc.output();
  const infoText = new TextDecoder().decode(infoResult.stdout);
  const widthMatch = infoText.match(/pixelWidth:\s*(\d+)/);
  const heightMatch = infoText.match(/pixelHeight:\s*(\d+)/);

  const stat = await Deno.stat(outputPath);

  return {
    outputPath,
    width: widthMatch ? parseInt(widthMatch[1]) : 0,
    height: heightMatch ? parseInt(heightMatch[1]) : 0,
    fileSizeBytes: stat.size,
    format: opts.format,
  };
}
