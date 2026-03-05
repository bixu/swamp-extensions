import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  normalizeObjectMeta,
  resolveBucket,
  resolveCredentials,
  resolveKey,
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

// --- resolveCredentials ---

Deno.test("resolveCredentials reads from env when no profile", async () => {
  const origAccess = Deno.env.get("AWS_ACCESS_KEY_ID");
  const origSecret = Deno.env.get("AWS_SECRET_ACCESS_KEY");
  const origSession = Deno.env.get("AWS_SESSION_TOKEN");

  try {
    Deno.env.set("AWS_ACCESS_KEY_ID", "AKIATEST");
    Deno.env.set("AWS_SECRET_ACCESS_KEY", "secret123");
    Deno.env.delete("AWS_SESSION_TOKEN");

    const creds = await resolveCredentials();
    assertEquals(creds.accessKey, "AKIATEST");
    assertEquals(creds.secretKey, "secret123");
    assertEquals(creds.sessionToken, undefined);
  } finally {
    if (origAccess) Deno.env.set("AWS_ACCESS_KEY_ID", origAccess);
    else Deno.env.delete("AWS_ACCESS_KEY_ID");
    if (origSecret) Deno.env.set("AWS_SECRET_ACCESS_KEY", origSecret);
    else Deno.env.delete("AWS_SECRET_ACCESS_KEY");
    if (origSession) Deno.env.set("AWS_SESSION_TOKEN", origSession);
    else Deno.env.delete("AWS_SESSION_TOKEN");
  }
});

Deno.test("resolveCredentials includes session token from env", async () => {
  const origAccess = Deno.env.get("AWS_ACCESS_KEY_ID");
  const origSecret = Deno.env.get("AWS_SECRET_ACCESS_KEY");
  const origSession = Deno.env.get("AWS_SESSION_TOKEN");

  try {
    Deno.env.set("AWS_ACCESS_KEY_ID", "AKIATEST");
    Deno.env.set("AWS_SECRET_ACCESS_KEY", "secret123");
    Deno.env.set("AWS_SESSION_TOKEN", "token456");

    const creds = await resolveCredentials();
    assertEquals(creds.accessKey, "AKIATEST");
    assertEquals(creds.secretKey, "secret123");
    assertEquals(creds.sessionToken, "token456");
  } finally {
    if (origAccess) Deno.env.set("AWS_ACCESS_KEY_ID", origAccess);
    else Deno.env.delete("AWS_ACCESS_KEY_ID");
    if (origSecret) Deno.env.set("AWS_SECRET_ACCESS_KEY", origSecret);
    else Deno.env.delete("AWS_SECRET_ACCESS_KEY");
    if (origSession) Deno.env.set("AWS_SESSION_TOKEN", origSession);
    else Deno.env.delete("AWS_SESSION_TOKEN");
  }
});

Deno.test("resolveCredentials throws when env vars missing", async () => {
  const origAccess = Deno.env.get("AWS_ACCESS_KEY_ID");
  const origSecret = Deno.env.get("AWS_SECRET_ACCESS_KEY");

  try {
    Deno.env.delete("AWS_ACCESS_KEY_ID");
    Deno.env.delete("AWS_SECRET_ACCESS_KEY");

    await assertRejects(
      () => resolveCredentials(),
      Error,
      "No AWS credentials found",
    );
  } finally {
    if (origAccess) Deno.env.set("AWS_ACCESS_KEY_ID", origAccess);
    if (origSecret) Deno.env.set("AWS_SECRET_ACCESS_KEY", origSecret);
  }
});

// --- normalizeObjectMeta ---

Deno.test("normalizeObjectMeta maps all fields", () => {
  const result = normalizeObjectMeta("my-bucket", "my-key.txt", {
    etag: '"abc123"',
    size: 1024,
    contentType: "text/plain",
    lastModified: new Date("2025-01-01T00:00:00Z"),
    versionId: "v1",
    storageClass: "STANDARD",
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

Deno.test("normalizeObjectMeta strips quotes from etag", () => {
  const result = normalizeObjectMeta("b", "k", { etag: '"quoted"' });
  assertEquals(result.etag, "quoted");
});

Deno.test("normalizeObjectMeta handles string lastModified", () => {
  const result = normalizeObjectMeta("b", "k", {
    lastModified: "2025-06-15T12:00:00Z",
  });
  assertEquals(result.lastModified, "2025-06-15T12:00:00Z");
});
