// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "jsr:@std/assert@1";
import {
  PlatformSchema,
  Sha256DigestSchema,
  SshFingerprintSchema,
} from "./schemas.ts";

// --- Sha256DigestSchema ---

Deno.test("Sha256DigestSchema: accepts a valid lowercase 64-hex digest", () => {
  const d = `sha256:${"a".repeat(64)}`;
  assertEquals(Sha256DigestSchema.parse(d), d);
});

Deno.test("Sha256DigestSchema: rejects the wrong prefix", () => {
  const r = Sha256DigestSchema.safeParse(`md5:${"a".repeat(64)}`);
  assertEquals(r.success, false);
});

Deno.test("Sha256DigestSchema: rejects an uppercase hex", () => {
  const r = Sha256DigestSchema.safeParse(`sha256:${"A".repeat(64)}`);
  assertEquals(r.success, false);
});

Deno.test("Sha256DigestSchema: rejects a short digest", () => {
  const r = Sha256DigestSchema.safeParse(`sha256:${"a".repeat(63)}`);
  assertEquals(r.success, false);
});

Deno.test("Sha256DigestSchema: rejects a long digest", () => {
  const r = Sha256DigestSchema.safeParse(`sha256:${"a".repeat(65)}`);
  assertEquals(r.success, false);
});

Deno.test("Sha256DigestSchema: rejects a tag string", () => {
  const r = Sha256DigestSchema.safeParse("v1.2.3");
  assertEquals(r.success, false);
});

// --- PlatformSchema ---

Deno.test("PlatformSchema: accepts bare arch", () => {
  assertEquals(PlatformSchema.parse("amd64"), "amd64");
});

Deno.test("PlatformSchema: accepts os/arch", () => {
  assertEquals(PlatformSchema.parse("linux/amd64"), "linux/amd64");
});

Deno.test("PlatformSchema: accepts os/arch/variant", () => {
  assertEquals(PlatformSchema.parse("linux/arm64/v8"), "linux/arm64/v8");
});

Deno.test("PlatformSchema: rejects four segments", () => {
  const r = PlatformSchema.safeParse("linux/arm64/v8/extra");
  assertEquals(r.success, false);
});

Deno.test("PlatformSchema: rejects uppercase", () => {
  const r = PlatformSchema.safeParse("Linux/AMD64");
  assertEquals(r.success, false);
});

Deno.test("PlatformSchema: rejects trailing slash", () => {
  const r = PlatformSchema.safeParse("linux/amd64/");
  assertEquals(r.success, false);
});

Deno.test("PlatformSchema: rejects empty string", () => {
  const r = PlatformSchema.safeParse("");
  assertEquals(r.success, false);
});

// --- SshFingerprintSchema ---

Deno.test("SshFingerprintSchema: accepts a SHA256 base64 fingerprint", () => {
  const fp = "SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU";
  assertEquals(SshFingerprintSchema.parse(fp), fp);
});

Deno.test("SshFingerprintSchema: accepts an MD5 hex-with-colons fingerprint", () => {
  const fp = "MD5:" +
    "01:23:45:67:89:ab:cd:ef:01:23:45:67:89:ab:cd:ef";
  assertEquals(SshFingerprintSchema.parse(fp), fp);
});

Deno.test("SshFingerprintSchema: rejects wrong algorithm prefix", () => {
  const r = SshFingerprintSchema.safeParse("SHA1:deadbeef");
  assertEquals(r.success, false);
});

Deno.test("SshFingerprintSchema: rejects MD5 with too few segments", () => {
  const r = SshFingerprintSchema.safeParse("MD5:01:23:45");
  assertEquals(r.success, false);
});

Deno.test("SshFingerprintSchema: rejects raw base64 with no prefix", () => {
  const r = SshFingerprintSchema.safeParse("47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMp");
  assertEquals(r.success, false);
});
