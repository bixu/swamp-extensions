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

export async function buildGlassUploadScript(
  filePath: string,
  title?: string,
  _category?: string,
): Promise<string> {
  const fileBytes = await Deno.readFile(filePath);
  const base64 = btoa(
    fileBytes.reduce((s, b) => s + String.fromCharCode(b), ""),
  );
  const filename = filePath.split("/").pop() || "photo.jpeg";
  const escapedTitle = title ? title.replace(/'/g, "\\'") : "";

  return `
tell application "Safari"
  activate
  open location "https://glass.photo"
  delay 3

  tell front document
    -- Wait for page to load
    repeat 30 times
      if (do JavaScript "document.readyState") is "complete" then exit repeat
      delay 1
    end repeat

    -- Click the + button to open picker modal
    do JavaScript "
      const plusBtn = document.querySelector('.fa-plus')?.closest('a, button') || document.querySelector('svg.fa-plus')?.parentElement;
      if (plusBtn) plusBtn.click();
    "
    delay 2

    -- Inject file directly into the hidden input (bypass native picker)
    do JavaScript "
      (function() {
        const input = document.querySelector('input[type=file]');
        if (!input) return 'no-input';
        const b64 = '${base64}';
        const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        const file = new File([bytes], '${filename}', {type: 'image/jpeg'});
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event('change', {bubbles: true}));
        return 'attached';
      })()
    "
    delay 3

    ${
    escapedTitle
      ? `-- Set title if a title input exists
    do JavaScript "
      const titleInput = document.querySelector('input[name=title], textarea[name=title], [placeholder*=itle], [aria-label*=itle]');
      if (titleInput) {
        titleInput.focus();
        titleInput.value = '${escapedTitle}';
        titleInput.dispatchEvent(new Event('input', {bubbles: true}));
      }
    "
    delay 1`
      : ""
  }

    -- Return current URL (user reviews and submits manually)
    set currentURL to URL
    return currentURL
  end tell
end tell`;
}
