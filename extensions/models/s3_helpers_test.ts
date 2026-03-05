import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildKey, contentTypeFromPath } from "./s3_utils.ts";

// --- contentTypeFromPath ---

Deno.test("contentTypeFromPath returns image/jpeg for .jpg", () => {
  assertEquals(contentTypeFromPath("photo.jpg"), "image/jpeg");
});

Deno.test("contentTypeFromPath returns image/jpeg for .jpeg", () => {
  assertEquals(contentTypeFromPath("/path/to/photo.jpeg"), "image/jpeg");
});

Deno.test("contentTypeFromPath returns image/png for .png", () => {
  assertEquals(contentTypeFromPath("image.png"), "image/png");
});

Deno.test("contentTypeFromPath returns image/webp for .webp", () => {
  assertEquals(contentTypeFromPath("photo.webp"), "image/webp");
});

Deno.test("contentTypeFromPath returns image/gif for .gif", () => {
  assertEquals(contentTypeFromPath("animation.gif"), "image/gif");
});

Deno.test("contentTypeFromPath returns application/pdf for .pdf", () => {
  assertEquals(contentTypeFromPath("doc.pdf"), "application/pdf");
});

Deno.test("contentTypeFromPath returns application/json for .json", () => {
  assertEquals(contentTypeFromPath("data.json"), "application/json");
});

Deno.test("contentTypeFromPath returns application/octet-stream for unknown", () => {
  assertEquals(contentTypeFromPath("file.xyz"), "application/octet-stream");
});

Deno.test("contentTypeFromPath is case-insensitive", () => {
  assertEquals(contentTypeFromPath("PHOTO.JPG"), "image/jpeg");
});

Deno.test("contentTypeFromPath handles path with directories", () => {
  assertEquals(
    contentTypeFromPath("/home/user/photos/sunset.png"),
    "image/png",
  );
});

// --- buildKey ---

Deno.test("buildKey uses filename without prefix", () => {
  assertEquals(buildKey("/home/user/photo.jpg"), "photo.jpg");
});

Deno.test("buildKey adds prefix", () => {
  assertEquals(
    buildKey("/home/user/photo.jpg", "uploads/images"),
    "uploads/images/photo.jpg",
  );
});

Deno.test("buildKey strips leading/trailing slashes from prefix", () => {
  assertEquals(
    buildKey("/home/user/photo.jpg", "/uploads/images/"),
    "uploads/images/photo.jpg",
  );
});

Deno.test("buildKey handles filename-only path", () => {
  assertEquals(buildKey("photo.jpg", "prefix"), "prefix/photo.jpg");
});

Deno.test("buildKey handles empty prefix as no prefix", () => {
  assertEquals(buildKey("/path/to/file.txt"), "file.txt");
});
