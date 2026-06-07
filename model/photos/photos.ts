/**
 * @module
 * Export photos from Apple Photos, process for web, and publish to Glass.
 *
 * Uses aphex-swift for Photos library access, macOS sips for image processing,
 * and playwright for browser-automated Glass uploads.
 */
import { z } from "npm:zod@4";
import {
  buildAphexCommand,
  parseAphexOutput,
  processWithSips,
  resolveExportDir,
} from "./photos_helpers.ts";

export const GlobalArgsSchema = z.object({
  album: z.string().describe("Apple Photos album name to publish from"),
  aphexBinaryPath: z.string().default(
    "/usr/local/bin/aphex-swift",
  ).describe("Path to the aphex-swift binary"),
  exportDir: z.string().optional().describe(
    "Directory for exported photos (default: temp dir)",
  ),
});

export const ExportArgsSchema = z.object({
  limit: z.number().optional().describe("Max photos to export"),
  originals: z.boolean().default(false).describe(
    "Export originals instead of edited versions",
  ),
});

const ExportedFileSchema = z.object({
  uuid: z.string(),
  filename: z.string(),
  exportedPath: z.string(),
  title: z.string().nullable(),
  dateCreated: z.string(),
});

export const ExportResultSchema = z.object({
  album: z.string(),
  exportedFiles: z.array(ExportedFileSchema),
  totalExported: z.number(),
  exportedAt: z.string(),
});

export const ProcessArgsSchema = z.object({
  maxWidth: z.number().default(2048).describe("Maximum width in pixels"),
  quality: z.number().min(1).max(100).default(90).describe("JPEG quality"),
  format: z.enum(["jpeg", "png", "tiff"]).default("jpeg").describe(
    "Output format (macOS sips-supported formats)",
  ),
});

const ProcessedFileSchema = z.object({
  sourcePath: z.string(),
  outputPath: z.string(),
  format: z.string(),
  width: z.number(),
  height: z.number(),
  fileSizeBytes: z.number(),
});

export const ProcessResultSchema = z.object({
  processedFiles: z.array(ProcessedFileSchema),
  totalProcessed: z.number(),
  processedAt: z.string(),
});

export const PublishArgsSchema = z.object({
  title: z.string().optional().describe("Override photo title for Glass"),
  category: z.string().optional().describe("Glass category"),
  headless: z.boolean().default(true).describe("Run browser in headless mode"),
});

const PublishedPhotoSchema = z.object({
  sourcePath: z.string(),
  glassUrl: z.string(),
  title: z.string().nullable(),
  publishedAt: z.string(),
});

const PublishFailureSchema = z.object({
  sourcePath: z.string(),
  error: z.string(),
});

export const PublishResultSchema = z.object({
  publishedPhotos: z.array(PublishedPhotoSchema),
  failures: z.array(PublishFailureSchema).optional(),
  totalPublished: z.number(),
  publishedAt: z.string(),
});

export const model = {
  type: "@bixu/photos",
  version: "2026.06.07.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "export": {
      description: "Exported photo files from Apple Photos",
      schema: ExportResultSchema,
      lifetime: "1d" as const,
      garbageCollection: 10,
    },
    "processed": {
      description: "Processed photos ready for upload",
      schema: ProcessResultSchema,
      lifetime: "1d" as const,
      garbageCollection: 10,
    },
    "published": {
      description: "Photos published to Glass",
      schema: PublishResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
  },
  methods: {
    export: {
      description:
        "Export photos from a named Apple Photos album using aphex-swift",
      arguments: ExportArgsSchema,
      execute: async (
        args: z.infer<typeof ExportArgsSchema>,
        context: {
          globalArgs: z.infer<typeof GlobalArgsSchema>;
          writeResource: (
            spec: string,
            name: string,
            data: unknown,
          ) => Promise<unknown>;
          logger: {
            info: (msg: string, meta?: Record<string, unknown>) => void;
          };
        },
      ) => {
        const { album, aphexBinaryPath, exportDir: configuredDir } =
          context.globalArgs;
        const exportDir = resolveExportDir(configuredDir, album);

        await Deno.mkdir(exportDir, { recursive: true });

        context.logger.info(`Querying album "${album}" via aphex-swift...`);
        const infoCmd = buildAphexCommand(aphexBinaryPath, "photo-info", [
          album,
        ]);
        const infoProc = new Deno.Command(infoCmd[0], {
          args: infoCmd.slice(1),
          stdout: "piped",
          stderr: "piped",
        });
        const infoOutput = await infoProc.output();
        const photos = parseAphexOutput(
          new TextDecoder().decode(infoOutput.stdout),
        );

        const toExport = args.limit ? photos.slice(0, args.limit) : photos;
        context.logger.info(
          `Found ${photos.length} photos, exporting ${toExport.length}...`,
        );

        const exportArgs = [album, "--destination", exportDir];
        if (args.originals) exportArgs.push("--originals");
        const exportCmd = buildAphexCommand(
          aphexBinaryPath,
          "export",
          exportArgs,
        );
        const exportProc = new Deno.Command(exportCmd[0], {
          args: exportCmd.slice(1),
          stdout: "piped",
          stderr: "piped",
        });
        const exportOutput = await exportProc.output();
        const exportedPaths: string[] = JSON.parse(
          new TextDecoder().decode(exportOutput.stdout),
        );

        const exportedFiles = toExport.slice(0, exportedPaths.length).map(
          (photo, i) => ({
            uuid: photo.uuid as string,
            filename: exportedPaths[i].split("/").pop() || "",
            exportedPath: exportedPaths[i],
            title: (photo.title as string) || null,
            dateCreated: photo.dateCreated as string,
          }),
        );

        const result = {
          album,
          exportedFiles,
          totalExported: exportedFiles.length,
          exportedAt: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "export",
          "current",
          result,
        );
        return { dataHandles: [handle] };
      },
    },
    process: {
      description:
        "Resize and convert exported photos for Glass using macOS sips",
      arguments: ProcessArgsSchema,
      execute: async (
        args: z.infer<typeof ProcessArgsSchema>,
        context: {
          globalArgs: z.infer<typeof GlobalArgsSchema>;
          readResource: (
            instanceName: string,
          ) => Promise<Record<string, unknown> | null>;
          writeResource: (
            spec: string,
            name: string,
            data: unknown,
          ) => Promise<unknown>;
          logger: {
            info: (msg: string, meta?: Record<string, unknown>) => void;
          };
        },
      ) => {
        const raw = await context.readResource!("current");
        if (!raw) throw new Error("No export data found — run export first");

        const exportData = raw as unknown as z.infer<typeof ExportResultSchema>;
        const processedDir = resolveExportDir(
          context.globalArgs.exportDir,
          context.globalArgs.album,
        ) + "/processed";
        await Deno.mkdir(processedDir, { recursive: true });

        const processedFiles = [];
        for (const file of exportData.exportedFiles) {
          context.logger.info(`Processing ${file.filename}...`);
          const result = await processWithSips(
            file.exportedPath,
            processedDir,
            {
              maxWidth: args.maxWidth,
              format: args.format,
              quality: args.quality,
            },
          );
          processedFiles.push({
            sourcePath: file.exportedPath,
            ...result,
          });
        }

        const result = {
          processedFiles,
          totalProcessed: processedFiles.length,
          processedAt: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "processed",
          "current",
          result,
        );
        return { dataHandles: [handle] };
      },
    },
    publish: {
      description: "Upload processed photos to Glass via browser automation",
      arguments: PublishArgsSchema,
      execute: async (
        args: z.infer<typeof PublishArgsSchema>,
        context: {
          globalArgs: z.infer<typeof GlobalArgsSchema>;
          readResource: (
            instanceName: string,
          ) => Promise<Record<string, unknown> | null>;
          writeResource: (
            spec: string,
            name: string,
            data: unknown,
          ) => Promise<unknown>;
          logger: {
            info: (msg: string, meta?: Record<string, unknown>) => void;
          };
        },
      ) => {
        const playwrightPkg = ["npm", "playwright@1.60.0"].join(":");
        const { chromium } = await import(playwrightPkg);
        const { join } = await import("jsr:@std/path@1");

        const raw = await context.readResource!("current");
        if (!raw) {
          throw new Error("No processed data found — run process first");
        }

        const processedData = raw as unknown as z.infer<
          typeof ProcessResultSchema
        >;

        const homeDir = Deno.env.get("HOME") || "/tmp";
        const authDir = join(homeDir, ".swamp-glass-auth");
        await Deno.mkdir(authDir, { recursive: true });

        const browser = await chromium.launchPersistentContext(authDir, {
          headless: args.headless,
          channel: "chromium",
        });
        const page = browser.pages()[0] || await browser.newPage();

        const publishedPhotos = [];
        const failures = [];

        try {
          await page.goto("https://glass.photo/upload");
          // Auth will use stored browser state or require manual login

          for (const file of processedData.processedFiles) {
            try {
              context.logger.info(`Uploading ${file.outputPath}...`);

              const fileInput = await page.locator('input[type="file"]');
              await fileInput.setInputFiles(file.outputPath);

              if (args.title) {
                const titleInput = await page.locator(
                  '[name="title"], [placeholder*="title"]',
                );
                await titleInput.fill(args.title);
              }

              if (args.category) {
                const categorySelect = await page.locator(
                  '[name="category"]',
                );
                await categorySelect.selectOption(args.category);
              }

              await page.locator(
                'button[type="submit"], button:has-text("Post")',
              ).click();
              await page.waitForURL(/glass\.photo\/\w+\/\w+/, {
                timeout: 30000,
              });

              publishedPhotos.push({
                sourcePath: file.outputPath,
                glassUrl: page.url(),
                title: args.title || null,
                publishedAt: new Date().toISOString(),
              });
            } catch (err) {
              failures.push({
                sourcePath: file.outputPath,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        } finally {
          await browser.close();
        }

        context.logger.info(
          `Auth state persisted to ${authDir} — future runs will reuse session`,
        );

        const result = {
          publishedPhotos,
          failures: failures.length > 0 ? failures : undefined,
          totalPublished: publishedPhotos.length,
          publishedAt: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "published",
          "current",
          result,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
