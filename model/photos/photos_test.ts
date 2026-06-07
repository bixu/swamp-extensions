import { assertEquals, assertExists } from "jsr:@std/assert@1";
import { describe, it } from "jsr:@std/testing@1/bdd";

import {
  GlobalArgsSchema,
  ProcessArgsSchema,
  ProcessResultSchema,
  PublishArgsSchema,
  PublishResultSchema,
  ScanArgsSchema,
  ScanResultSchema,
} from "./photos.ts";

describe("photos schemas", () => {
  describe("GlobalArgsSchema", () => {
    it("requires sourceDir", () => {
      const result = GlobalArgsSchema.safeParse({
        sourceDir: "/Users/me/Photos/Glass",
      });
      assertEquals(result.success, true);
    });

    it("accepts optional exportDir", () => {
      const result = GlobalArgsSchema.safeParse({
        sourceDir: "/Users/me/Photos/Glass",
        exportDir: "/tmp/glass-processed",
      });
      assertEquals(result.success, true);
    });

    it("rejects missing sourceDir", () => {
      const result = GlobalArgsSchema.safeParse({});
      assertEquals(result.success, false);
    });
  });

  describe("ScanArgsSchema", () => {
    it("accepts empty object", () => {
      const result = ScanArgsSchema.safeParse({});
      assertEquals(result.success, true);
    });

    it("accepts extensions filter", () => {
      const result = ScanArgsSchema.safeParse({
        extensions: ["jpeg", "heic"],
      });
      assertEquals(result.success, true);
    });
  });

  describe("ScanResultSchema", () => {
    it("validates a scan result with new files", () => {
      const data = {
        sourceDir: "/Users/me/Photos/Glass",
        newFiles: ["/Users/me/Photos/Glass/sunset.heic"],
        previouslyProcessed: ["older.jpeg"],
        totalNew: 1,
        scannedAt: "2026-06-07T20:00:00.000Z",
      };
      assertEquals(ScanResultSchema.safeParse(data).success, true);
    });

    it("validates empty scan (no new files)", () => {
      const data = {
        sourceDir: "/Users/me/Photos/Glass",
        newFiles: [],
        previouslyProcessed: ["sunset.heic"],
        totalNew: 0,
        scannedAt: "2026-06-07T20:00:00.000Z",
      };
      assertEquals(ScanResultSchema.safeParse(data).success, true);
    });
  });

  describe("ProcessArgsSchema", () => {
    it("accepts empty object (defaults)", () => {
      assertEquals(ProcessArgsSchema.safeParse({}).success, true);
    });

    it("accepts maxWidth", () => {
      assertEquals(
        ProcessArgsSchema.safeParse({ maxWidth: 2048 }).success,
        true,
      );
    });

    it("accepts quality", () => {
      assertEquals(ProcessArgsSchema.safeParse({ quality: 85 }).success, true);
    });

    it("accepts output format", () => {
      assertEquals(
        ProcessArgsSchema.safeParse({ format: "jpeg" }).success,
        true,
      );
    });

    it("rejects unsupported format", () => {
      assertEquals(
        ProcessArgsSchema.safeParse({ format: "webp" }).success,
        false,
      );
    });
  });

  describe("ProcessResultSchema", () => {
    it("validates a process result", () => {
      const data = {
        processedFiles: [
          {
            sourcePath: "/Users/me/Photos/Glass/sunset.heic",
            outputPath: "/tmp/glass-processed/sunset.jpeg",
            format: "jpeg",
            width: 2048,
            height: 1365,
            fileSizeBytes: 524288,
          },
        ],
        totalProcessed: 1,
        processedAt: "2026-06-07T20:01:00.000Z",
      };
      assertEquals(ProcessResultSchema.safeParse(data).success, true);
    });
  });

  describe("PublishArgsSchema", () => {
    it("accepts empty object", () => {
      assertEquals(PublishArgsSchema.safeParse({}).success, true);
    });

    it("accepts optional title", () => {
      assertEquals(
        PublishArgsSchema.safeParse({ title: "My Photo" }).success,
        true,
      );
    });
  });

  describe("PublishResultSchema", () => {
    it("validates a publish result", () => {
      const data = {
        publishedPhotos: [
          {
            sourcePath: "/tmp/glass-processed/sunset.jpeg",
            glassUrl: "https://glass.photo/user/abc123",
            title: "Sunset",
            publishedAt: "2026-06-07T20:02:00.000Z",
          },
        ],
        totalPublished: 1,
        publishedAt: "2026-06-07T20:02:30.000Z",
      };
      assertEquals(PublishResultSchema.safeParse(data).success, true);
    });

    it("captures failures", () => {
      const data = {
        publishedPhotos: [],
        failures: [{ sourcePath: "/tmp/x.jpeg", error: "timeout" }],
        totalPublished: 0,
        publishedAt: "2026-06-07T20:02:30.000Z",
      };
      assertEquals(PublishResultSchema.safeParse(data).success, true);
    });
  });
});

describe("photos helpers", () => {
  describe("scanDirectory", () => {
    it("is exported as a function", async () => {
      const { scanDirectory } = await import("./photos_helpers.ts");
      assertEquals(typeof scanDirectory, "function");
    });
  });

  describe("processWithSips", () => {
    it("is exported as a function", async () => {
      const { processWithSips } = await import("./photos_helpers.ts");
      assertEquals(typeof processWithSips, "function");
    });
  });

  describe("buildGlassUploadScript", () => {
    it("is exported as a function", async () => {
      const { buildGlassUploadScript } = await import("./photos_helpers.ts");
      assertEquals(typeof buildGlassUploadScript, "function");
    });
  });
});

describe("model export", () => {
  it("exports a model with correct type", async () => {
    const { model } = await import("./photos.ts");
    assertEquals(model.type, "@bixu/photos");
    assertExists(model.methods.scan);
    assertExists(model.methods.process);
    assertExists(model.methods.publish);
  });

  it("has globalArguments schema", async () => {
    const { model } = await import("./photos.ts");
    assertExists(model.globalArguments);
    assertEquals(
      model.globalArguments.safeParse({ sourceDir: "/tmp" }).success,
      true,
    );
  });

  it("defines scan resource spec", async () => {
    const { model } = await import("./photos.ts");
    assertExists(model.resources["scan"]);
  });

  it("defines processed resource spec", async () => {
    const { model } = await import("./photos.ts");
    assertExists(model.resources["processed"]);
  });

  it("defines published resource spec", async () => {
    const { model } = await import("./photos.ts");
    assertExists(model.resources["published"]);
    assertEquals(model.resources["published"].lifetime, "infinite");
  });
});
