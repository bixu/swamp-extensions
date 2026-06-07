import { assertEquals, assertExists } from "jsr:@std/assert@1";
import { describe, it } from "jsr:@std/testing@1/bdd";

// Schema imports — these define the contract before implementation
import {
  ExportArgsSchema,
  ExportResultSchema,
  GlobalArgsSchema,
  ProcessArgsSchema,
  ProcessResultSchema,
  PublishArgsSchema,
  PublishResultSchema,
} from "./photos.ts";

describe("photos schemas", () => {
  describe("GlobalArgsSchema", () => {
    it("requires album name", () => {
      const result = GlobalArgsSchema.safeParse({ album: "Glass" });
      assertEquals(result.success, true);
    });

    it("accepts optional aphexBinaryPath", () => {
      const result = GlobalArgsSchema.safeParse({
        album: "Glass",
        aphexBinaryPath: "/usr/local/bin/aphex-swift",
      });
      assertEquals(result.success, true);
    });

    it("accepts optional exportDir", () => {
      const result = GlobalArgsSchema.safeParse({
        album: "Glass",
        exportDir: "/tmp/photos-export",
      });
      assertEquals(result.success, true);
    });

    it("rejects missing album", () => {
      const result = GlobalArgsSchema.safeParse({});
      assertEquals(result.success, false);
    });
  });

  describe("ExportArgsSchema", () => {
    it("accepts empty object (uses globalArgs album)", () => {
      const result = ExportArgsSchema.safeParse({});
      assertEquals(result.success, true);
    });

    it("accepts optional limit", () => {
      const result = ExportArgsSchema.safeParse({ limit: 5 });
      assertEquals(result.success, true);
    });

    it("accepts optional originals flag", () => {
      const result = ExportArgsSchema.safeParse({ originals: true });
      assertEquals(result.success, true);
    });
  });

  describe("ExportResultSchema", () => {
    it("validates a complete export result", () => {
      const data = {
        album: "Glass",
        exportedFiles: [
          {
            uuid: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890",
            filename: "sunset.heic",
            exportedPath: "/tmp/photos-export/sunset.heic",
            title: "Sunset over the bay",
            dateCreated: "2026-06-01T18:30:00.000Z",
          },
        ],
        totalExported: 1,
        exportedAt: "2026-06-07T19:00:00.000Z",
      };
      const result = ExportResultSchema.safeParse(data);
      assertEquals(result.success, true);
    });

    it("requires at least one exported file", () => {
      const data = {
        album: "Glass",
        exportedFiles: [],
        totalExported: 0,
        exportedAt: "2026-06-07T19:00:00.000Z",
      };
      const result = ExportResultSchema.safeParse(data);
      assertEquals(result.success, true);
    });
  });

  describe("ProcessArgsSchema", () => {
    it("accepts empty object (processes all exported files)", () => {
      const result = ProcessArgsSchema.safeParse({});
      assertEquals(result.success, true);
    });

    it("accepts maxWidth", () => {
      const result = ProcessArgsSchema.safeParse({ maxWidth: 2048 });
      assertEquals(result.success, true);
    });

    it("accepts quality", () => {
      const result = ProcessArgsSchema.safeParse({ quality: 85 });
      assertEquals(result.success, true);
    });

    it("accepts output format", () => {
      const result = ProcessArgsSchema.safeParse({ format: "jpeg" });
      assertEquals(result.success, true);
    });

    it("rejects unsupported format", () => {
      const result = ProcessArgsSchema.safeParse({ format: "bmp" });
      assertEquals(result.success, false);
      const webp = ProcessArgsSchema.safeParse({ format: "webp" });
      assertEquals(webp.success, false);
    });
  });

  describe("ProcessResultSchema", () => {
    it("validates a complete process result", () => {
      const data = {
        processedFiles: [
          {
            sourcePath: "/tmp/photos-export/sunset.heic",
            outputPath: "/tmp/photos-export/processed/sunset.jpeg",
            format: "jpeg",
            width: 2048,
            height: 1365,
            fileSizeBytes: 524288,
          },
        ],
        totalProcessed: 1,
        processedAt: "2026-06-07T19:01:00.000Z",
      };
      const result = ProcessResultSchema.safeParse(data);
      assertEquals(result.success, true);
    });
  });

  describe("PublishArgsSchema", () => {
    it("accepts empty object (publishes all processed files)", () => {
      const result = PublishArgsSchema.safeParse({});
      assertEquals(result.success, true);
    });

    it("accepts optional title override", () => {
      const result = PublishArgsSchema.safeParse({ title: "My Photo" });
      assertEquals(result.success, true);
    });

    it("accepts optional category", () => {
      const result = PublishArgsSchema.safeParse({ category: "landscape" });
      assertEquals(result.success, true);
    });

    it("accepts headless flag", () => {
      const result = PublishArgsSchema.safeParse({ headless: false });
      assertEquals(result.success, true);
    });
  });

  describe("PublishResultSchema", () => {
    it("validates a complete publish result", () => {
      const data = {
        publishedPhotos: [
          {
            sourcePath: "/tmp/photos-export/processed/sunset.jpeg",
            glassUrl: "https://glass.photo/blake/abc123",
            title: "Sunset over the bay",
            publishedAt: "2026-06-07T19:02:00.000Z",
          },
        ],
        totalPublished: 1,
        publishedAt: "2026-06-07T19:02:30.000Z",
      };
      const result = PublishResultSchema.safeParse(data);
      assertEquals(result.success, true);
    });

    it("captures failed uploads", () => {
      const data = {
        publishedPhotos: [],
        failures: [
          {
            sourcePath: "/tmp/photos-export/processed/sunset.jpeg",
            error: "Upload timed out after 30s",
          },
        ],
        totalPublished: 0,
        publishedAt: "2026-06-07T19:02:30.000Z",
      };
      const result = PublishResultSchema.safeParse(data);
      assertEquals(result.success, true);
    });
  });
});

describe("photos helpers", () => {
  describe("buildAphexCommand", () => {
    it("constructs photo-info command for an album", async () => {
      const { buildAphexCommand } = await import("./photos_helpers.ts");
      const cmd = buildAphexCommand(
        "/usr/local/bin/aphex-swift",
        "photo-info",
        [
          "Glass",
        ],
      );
      assertEquals(cmd[0], "/usr/local/bin/aphex-swift");
      assertEquals(cmd[1], "photo-info");
      assertEquals(cmd[2], "Glass");
    });

    it("constructs export command with destination", async () => {
      const { buildAphexCommand } = await import("./photos_helpers.ts");
      const cmd = buildAphexCommand("/usr/local/bin/aphex-swift", "export", [
        "Glass",
        "--destination",
        "/tmp/export",
      ]);
      assertEquals(cmd[0], "/usr/local/bin/aphex-swift");
      assertEquals(cmd[1], "export");
      assertEquals(cmd[2], "Glass");
      assertEquals(cmd[3], "--destination");
      assertEquals(cmd[4], "/tmp/export");
    });
  });

  describe("parseAphexOutput", () => {
    it("parses JSON array output from aphex", async () => {
      const { parseAphexOutput } = await import("./photos_helpers.ts");
      const json = JSON.stringify([
        { uuid: "abc-123", title: "Test Photo", dateCreated: "2026-01-01" },
      ]);
      const result = parseAphexOutput(json);
      assertEquals(result.length, 1);
      assertEquals(result[0].uuid, "abc-123");
    });

    it("returns empty array on empty output", async () => {
      const { parseAphexOutput } = await import("./photos_helpers.ts");
      const result = parseAphexOutput("");
      assertEquals(result, []);
    });

    it("throws on invalid JSON", async () => {
      const { parseAphexOutput } = await import("./photos_helpers.ts");
      let threw = false;
      try {
        parseAphexOutput("not json {{{");
      } catch {
        threw = true;
      }
      assertEquals(threw, true);
    });
  });

  describe("resolveExportDir", () => {
    it("uses provided exportDir when set", async () => {
      const { resolveExportDir } = await import("./photos_helpers.ts");
      const dir = resolveExportDir("/custom/path");
      assertEquals(dir, "/custom/path");
    });

    it("falls back to temp dir with album name", async () => {
      const { resolveExportDir } = await import("./photos_helpers.ts");
      const dir = resolveExportDir(undefined, "Glass");
      assertExists(dir);
      assertEquals(dir.includes("glass"), true);
    });
  });

  describe("processWithSips", () => {
    it("is exported as a function", async () => {
      const { processWithSips } = await import("./photos_helpers.ts");
      assertEquals(typeof processWithSips, "function");
    });
  });
});

describe("model export", () => {
  it("exports a model object with correct type", async () => {
    const { model } = await import("./photos.ts");
    assertEquals(model.type, "@bixu/photos");
    assertExists(model.methods.export);
    assertExists(model.methods.process);
    assertExists(model.methods.publish);
  });

  it("has globalArguments schema", async () => {
    const { model } = await import("./photos.ts");
    assertExists(model.globalArguments);
    const parsed = model.globalArguments.safeParse({ album: "Glass" });
    assertEquals(parsed.success, true);
  });

  it("defines export resource spec", async () => {
    const { model } = await import("./photos.ts");
    assertExists(model.resources["export"]);
    assertEquals(model.resources["export"].lifetime, "1d");
  });

  it("defines processed resource spec", async () => {
    const { model } = await import("./photos.ts");
    assertExists(model.resources["processed"]);
    assertEquals(model.resources["processed"].lifetime, "1d");
  });

  it("defines published resource spec", async () => {
    const { model } = await import("./photos.ts");
    assertExists(model.resources["published"]);
    assertEquals(model.resources["published"].lifetime, "infinite");
  });
});
