import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  normalizeObjectMeta,
  recordToTagSet,
  resolveBucket,
  resolveKey,
  streamToBytes,
  tagSetToRecord,
} from "./s3_helpers.ts";

// --- resolveBucket ---

Deno.test("resolveBucket returns method arg when both provided", () => {
  assertEquals(
    resolveBucket("method-bucket", "global-bucket"),
    "method-bucket",
  );
});

Deno.test("resolveBucket falls back to global when method arg missing", () => {
  assertEquals(resolveBucket(undefined, "global-bucket"), "global-bucket");
});

Deno.test("resolveBucket falls back to global when method arg empty", () => {
  assertEquals(resolveBucket("", "global-bucket"), "global-bucket");
});

Deno.test("resolveBucket throws when neither provided", () => {
  assertThrows(
    () => resolveBucket(undefined, undefined),
    Error,
    "No bucket specified",
  );
});

Deno.test("resolveBucket throws when both are empty strings", () => {
  assertThrows(
    () => resolveBucket("", ""),
    Error,
    "No bucket specified",
  );
});

// --- resolveKey ---

Deno.test("resolveKey returns key unchanged when no prefix", () => {
  assertEquals(resolveKey("path/to/file.txt"), "path/to/file.txt");
});

Deno.test("resolveKey returns key unchanged when prefix is undefined", () => {
  assertEquals(resolveKey("file.txt", undefined), "file.txt");
});

Deno.test("resolveKey prepends prefix", () => {
  assertEquals(resolveKey("file.txt", "uploads"), "uploads/file.txt");
});

Deno.test("resolveKey strips leading/trailing slashes from prefix", () => {
  assertEquals(resolveKey("file.txt", "/uploads/"), "uploads/file.txt");
});

Deno.test("resolveKey handles prefix with nested path", () => {
  assertEquals(resolveKey("file.txt", "a/b/c"), "a/b/c/file.txt");
});

Deno.test("resolveKey handles empty prefix as no prefix", () => {
  assertEquals(resolveKey("file.txt", ""), "file.txt");
});

Deno.test("resolveKey handles prefix that is only slashes", () => {
  assertEquals(resolveKey("file.txt", "///"), "file.txt");
});

// --- streamToBytes ---

Deno.test("streamToBytes passes through Uint8Array", async () => {
  const input = new Uint8Array([1, 2, 3]);
  const result = await streamToBytes(input);
  assertEquals(result, input);
});

Deno.test("streamToBytes encodes string to Uint8Array", async () => {
  const result = await streamToBytes("hello");
  assertEquals(result, new TextEncoder().encode("hello"));
});

Deno.test("streamToBytes drains ReadableStream", async () => {
  const data = new TextEncoder().encode("stream data");
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
  const result = await streamToBytes(stream);
  assertEquals(result, data);
});

// --- normalizeObjectMeta ---

Deno.test("normalizeObjectMeta maps all SDK fields", () => {
  const result = normalizeObjectMeta("my-bucket", "my-key.txt", {
    ETag: '"abc123"',
    ContentLength: 1024,
    ContentType: "text/plain",
    LastModified: new Date("2025-01-01T00:00:00Z"),
    VersionId: "v1",
    StorageClass: "STANDARD",
  });
  assertEquals(result, {
    bucket: "my-bucket",
    key: "my-key.txt",
    etag: "abc123",
    size: 1024,
    contentType: "text/plain",
    lastModified: "2025-01-01T00:00:00.000Z",
    versionId: "v1",
    storageClass: "STANDARD",
  });
});

Deno.test("normalizeObjectMeta handles missing optional fields", () => {
  const result = normalizeObjectMeta("b", "k.json", {});
  assertEquals(result, {
    bucket: "b",
    key: "k.json",
    etag: null,
    size: null,
    contentType: "application/json",
    lastModified: null,
    versionId: null,
    storageClass: null,
  });
});

Deno.test("normalizeObjectMeta strips quotes from ETag", () => {
  const result = normalizeObjectMeta("b", "k", { ETag: '"quoted"' });
  assertEquals(result.etag, "quoted");
});

Deno.test("normalizeObjectMeta handles string LastModified", () => {
  const result = normalizeObjectMeta("b", "k", {
    LastModified: "2025-06-15T12:00:00Z",
  });
  assertEquals(result.lastModified, "2025-06-15T12:00:00Z");
});

// --- tagSetToRecord ---

Deno.test("tagSetToRecord converts tag array to record", () => {
  const result = tagSetToRecord([
    { Key: "env", Value: "prod" },
    { Key: "team", Value: "platform" },
  ]);
  assertEquals(result, { env: "prod", team: "platform" });
});

Deno.test("tagSetToRecord handles empty array", () => {
  assertEquals(tagSetToRecord([]), {});
});

Deno.test("tagSetToRecord handles missing Value", () => {
  const result = tagSetToRecord([{ Key: "flag" }]);
  assertEquals(result, { flag: "" });
});

Deno.test("tagSetToRecord skips entries without Key", () => {
  const result = tagSetToRecord([{ Value: "orphan" }]);
  assertEquals(result, {});
});

// --- recordToTagSet ---

Deno.test("recordToTagSet converts record to tag array", () => {
  const result = recordToTagSet({ env: "prod", team: "platform" });
  assertEquals(result, [
    { Key: "env", Value: "prod" },
    { Key: "team", Value: "platform" },
  ]);
});

Deno.test("recordToTagSet handles empty record", () => {
  assertEquals(recordToTagSet({}), []);
});
