/**
 * @module
 * Watch a directory for new photos, process for web, and publish to Glass.
 *
 * Uses macOS sips for image processing and Safari AppleScript for Glass uploads.
 * Designed to run as a scheduled workflow via swamp serve.
 */
import { z } from "npm:zod@4";
import {
  buildGlassUploadScript,
  processWithSips,
  scanDirectory,
} from "./photos_helpers.ts";

/** Global arguments: source directory and optional processing output path. */
export const GlobalArgsSchema = z.object({
  sourceDir: z.string().describe("Directory to watch for new photos"),
  exportDir: z.string().optional().describe(
    "Directory for processed output (default: sourceDir/processed)",
  ),
});

/** Arguments for the scan method. */
export const ScanArgsSchema = z.object({
  extensions: z.array(z.string()).optional().describe(
    "File extensions to include (default: jpeg, jpg, heic, heif, png, tiff)",
  ),
});

/** Schema for scan method output. */
export const ScanResultSchema = z.object({
  sourceDir: z.string(),
  newFiles: z.array(z.string()),
  previouslyProcessed: z.array(z.string()),
  totalNew: z.number(),
  scannedAt: z.string(),
});

/** Arguments for the process method. */
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

/** Schema for process method output. */
export const ProcessResultSchema = z.object({
  processedFiles: z.array(ProcessedFileSchema),
  totalProcessed: z.number(),
  processedAt: z.string(),
});

/** Arguments for the publish method. */
export const PublishArgsSchema = z.object({
  title: z.string().optional().describe("Override photo title for Glass"),
  category: z.string().optional().describe("Glass category"),
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

/** Schema for publish method output. */
export const PublishResultSchema = z.object({
  publishedPhotos: z.array(PublishedPhotoSchema),
  failures: z.array(PublishFailureSchema).optional(),
  totalPublished: z.number(),
  publishedAt: z.string(),
});

/** Schema for export method output (kept for compatibility). */
export const ExportResultSchema = ScanResultSchema;

/** Photos extension model — directory watcher to Glass pipeline. */
export const model = {
  type: "@bixu/photos",
  version: "2026.06.07.2",
  globalArguments: GlobalArgsSchema,
  resources: {
    "scan": {
      description: "Scan results — new files found in source directory",
      schema: ScanResultSchema,
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
    scan: {
      description:
        "Scan source directory for new image files not yet processed",
      arguments: ScanArgsSchema,
      execute: async (
        args: z.infer<typeof ScanArgsSchema>,
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
        const { sourceDir } = context.globalArgs;
        const allFiles = await scanDirectory(sourceDir, args.extensions);

        const prev = await context.readResource!("scan-state");
        const previouslyProcessed: string[] = prev
          ? (prev as { processed: string[] }).processed || []
          : [];

        const processedSet = new Set(previouslyProcessed);
        const newFiles = allFiles.filter((f) => !processedSet.has(f));

        context.logger.info(
          `Scanned ${sourceDir}: ${allFiles.length} total, ${newFiles.length} new`,
        );

        const result = {
          sourceDir,
          newFiles,
          previouslyProcessed,
          totalNew: newFiles.length,
          scannedAt: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "scan",
          "scan-current",
          result,
        );
        return { dataHandles: [handle] };
      },
    },
    process: {
      description:
        "Resize and convert scanned photos for Glass using macOS sips",
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
        const raw = await context.readResource!("scan-current");
        if (!raw) throw new Error("No scan data found — run scan first");

        const scanData = raw as unknown as z.infer<typeof ScanResultSchema>;
        if (scanData.newFiles.length === 0) {
          context.logger.info("No new files to process");
          const result = {
            processedFiles: [],
            totalProcessed: 0,
            processedAt: new Date().toISOString(),
          };
          const handle = await context.writeResource(
            "processed",
            "process-current",
            result,
          );
          return { dataHandles: [handle] };
        }

        const processedDir = context.globalArgs.exportDir ||
          `${context.globalArgs.sourceDir}/processed`;
        await Deno.mkdir(processedDir, { recursive: true });

        const processedFiles = [];
        for (const filePath of scanData.newFiles) {
          const filename = filePath.split("/").pop() || "";
          context.logger.info(`Processing ${filename}...`);
          const result = await processWithSips(filePath, processedDir, {
            maxWidth: args.maxWidth,
            format: args.format,
            quality: args.quality,
          });
          processedFiles.push({ sourcePath: filePath, ...result });
        }

        // Update the processed-files tracker
        const prev = await context.readResource!("scan-state");
        const previouslyProcessed: string[] = prev
          ? (prev as { processed: string[] }).processed || []
          : [];
        const updatedProcessed = [
          ...previouslyProcessed,
          ...scanData.newFiles,
        ];
        await context.writeResource("scan", "scan-state", {
          processed: updatedProcessed,
        });

        const result = {
          processedFiles,
          totalProcessed: processedFiles.length,
          processedAt: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "processed",
          "process-current",
          result,
        );
        return { dataHandles: [handle] };
      },
    },
    publish: {
      description:
        "Stage processed photos in Glass upload modal via Safari AppleScript",
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
        const raw = await context.readResource!("process-current");
        if (!raw) {
          throw new Error("No processed data found — run process first");
        }

        const processedData = raw as unknown as z.infer<
          typeof ProcessResultSchema
        >;

        if (processedData.processedFiles.length === 0) {
          context.logger.info("No processed files to publish");
          const result = {
            publishedPhotos: [],
            totalPublished: 0,
            publishedAt: new Date().toISOString(),
          };
          const handle = await context.writeResource(
            "published",
            "publish-current",
            result,
          );
          return { dataHandles: [handle] };
        }

        const publishedPhotos = [];
        const failures = [];

        for (const file of processedData.processedFiles) {
          try {
            context.logger.info(`Uploading ${file.outputPath} to Glass...`);

            const script = await buildGlassUploadScript(
              file.outputPath,
              args.title,
            );

            const proc = new Deno.Command("osascript", {
              args: ["-e", script],
              stdout: "piped",
              stderr: "piped",
            });
            const result = await proc.output();

            if (!result.success) {
              const stderr = new TextDecoder().decode(result.stderr);
              throw new Error(`AppleScript failed: ${stderr}`);
            }

            const url = new TextDecoder().decode(result.stdout).trim();
            publishedPhotos.push({
              sourcePath: file.outputPath,
              glassUrl: url || "https://glass.photo",
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

        const result = {
          publishedPhotos,
          failures: failures.length > 0 ? failures : undefined,
          totalPublished: publishedPhotos.length,
          publishedAt: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "published",
          "publish-current",
          result,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
