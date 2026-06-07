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
  buildGlassUploadScript,
  parseAphexOutput,
  processWithSips,
  resolveExportDir,
} from "./photos_helpers.ts";

/** Global arguments: album name and optional binary/export paths. */
export const GlobalArgsSchema = z.object({
  album: z.string().describe("Apple Photos album name to publish from"),
  aphexBinaryPath: z.string().default(
    "/usr/local/bin/aphex-swift",
  ).describe("Path to the aphex-swift binary"),
  exportDir: z.string().optional().describe(
    "Directory for exported photos (default: temp dir)",
  ),
});

/** Arguments for the export method. */
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

/** Schema for export method output. */
export const ExportResultSchema = z.object({
  album: z.string(),
  exportedFiles: z.array(ExportedFileSchema),
  totalExported: z.number(),
  exportedAt: z.string(),
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

/** Photos extension model — Apple Photos to Glass pipeline. */
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
          "export-current",
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
        const raw = await context.readResource!("export-current");
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
          "process-current",
          result,
        );
        return { dataHandles: [handle] };
      },
    },
    publish: {
      description:
        "Upload processed photos to Glass via Safari AppleScript automation",
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

        const publishedPhotos = [];
        const failures = [];

        for (const file of processedData.processedFiles) {
          try {
            context.logger.info(`Uploading ${file.outputPath} to Glass...`);

            const script = await buildGlassUploadScript(
              file.outputPath,
              args.title,
              args.category,
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
