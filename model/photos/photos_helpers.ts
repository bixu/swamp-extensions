import { join } from "jsr:@std/path@1";

const IMAGE_EXTENSIONS = new Set([
  "jpeg",
  "jpg",
  "heic",
  "heif",
  "png",
  "tiff",
  "tif",
]);

export async function scanDirectory(
  sourceDir: string,
  extensions?: string[],
): Promise<string[]> {
  const allowedExts = extensions
    ? new Set(extensions.map((e) => e.toLowerCase()))
    : IMAGE_EXTENSIONS;

  const files: string[] = [];
  for await (const entry of Deno.readDir(sourceDir)) {
    if (!entry.isFile) continue;
    const ext = entry.name.split(".").pop()?.toLowerCase() || "";
    if (allowedExts.has(ext)) {
      files.push(join(sourceDir, entry.name));
    }
  }
  return files.sort();
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
    repeat 30 times
      if (do JavaScript "document.readyState") is "complete" then exit repeat
      delay 1
    end repeat

    do JavaScript "
      const plusBtn = document.querySelector('.fa-plus')?.closest('a, button') || document.querySelector('svg.fa-plus')?.parentElement;
      if (plusBtn) plusBtn.click();
    "
    delay 2

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
      ? `do JavaScript "
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

    set currentURL to URL
    return currentURL
  end tell
end tell`;
}
