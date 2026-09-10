// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "jsr:@std/assert@1";
import {
  GitCommitShaSchema,
  PgpFingerprintSchema,
  PlatformSchema,
  Sha256DigestSchema,
  Sha256HexSchema,
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

// --- Sha256HexSchema ---

Deno.test("Sha256HexSchema: accepts 64 lowercase hex", () => {
  const h = "a".repeat(64);
  assertEquals(Sha256HexSchema.parse(h), h);
});

Deno.test("Sha256HexSchema: accepts a real-looking mixed hex", () => {
  const h = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  assertEquals(Sha256HexSchema.parse(h), h);
});

Deno.test("Sha256HexSchema: rejects the sha256: prefixed form (distinct from Sha256DigestSchema)", () => {
  const r = Sha256HexSchema.safeParse(`sha256:${"a".repeat(64)}`);
  assertEquals(r.success, false);
});

Deno.test("Sha256HexSchema: rejects uppercase hex", () => {
  const r = Sha256HexSchema.safeParse("A".repeat(64));
  assertEquals(r.success, false);
});

Deno.test("Sha256HexSchema: rejects a short hex", () => {
  const r = Sha256HexSchema.safeParse("a".repeat(63));
  assertEquals(r.success, false);
});

Deno.test("Sha256HexSchema: rejects a long hex", () => {
  const r = Sha256HexSchema.safeParse("a".repeat(65));
  assertEquals(r.success, false);
});

Deno.test("Sha256HexSchema: rejects non-hex chars", () => {
  const r = Sha256HexSchema.safeParse("g".repeat(64));
  assertEquals(r.success, false);
});

// --- GitCommitShaSchema ---

Deno.test("GitCommitShaSchema: accepts 40 lowercase hex", () => {
  const s = "1234567890abcdef1234567890abcdef12345678";
  assertEquals(GitCommitShaSchema.parse(s), s);
});

Deno.test("GitCommitShaSchema: rejects an abbreviated 7-char sha", () => {
  const r = GitCommitShaSchema.safeParse("1234567");
  assertEquals(r.success, false);
});

Deno.test("GitCommitShaSchema: rejects an abbreviated 12-char sha", () => {
  const r = GitCommitShaSchema.safeParse("1234567890ab");
  assertEquals(r.success, false);
});

Deno.test("GitCommitShaSchema: rejects uppercase hex", () => {
  const r = GitCommitShaSchema.safeParse("A".repeat(40));
  assertEquals(r.success, false);
});

Deno.test("GitCommitShaSchema: rejects a 64-char (sha256-length) hex", () => {
  const r = GitCommitShaSchema.safeParse("a".repeat(64));
  assertEquals(r.success, false);
});

Deno.test("GitCommitShaSchema: rejects non-hex characters", () => {
  const r = GitCommitShaSchema.safeParse(
    "z234567890abcdef1234567890abcdef12345678",
  );
  assertEquals(r.success, false);
});

// --- PgpFingerprintSchema ---

Deno.test("PgpFingerprintSchema: accepts a 40-hex v4 fingerprint", () => {
  const fp = "ABAF11C65A2970B130ABE3C479BE3E4300411886";
  assertEquals(PgpFingerprintSchema.parse(fp), fp);
});

Deno.test("PgpFingerprintSchema: accepts a 64-hex v5 fingerprint", () => {
  const fp = "A".repeat(64);
  assertEquals(PgpFingerprintSchema.parse(fp), fp);
});

Deno.test("PgpFingerprintSchema: rejects lowercase hex", () => {
  const r = PgpFingerprintSchema.safeParse("a".repeat(40));
  assertEquals(r.success, false);
});

Deno.test("PgpFingerprintSchema: rejects mixed case", () => {
  const r = PgpFingerprintSchema.safeParse(
    "ABAF11c65A2970B130ABE3C479BE3E4300411886",
  );
  assertEquals(r.success, false);
});

Deno.test("PgpFingerprintSchema: rejects an intermediate length (48 chars)", () => {
  const r = PgpFingerprintSchema.safeParse("A".repeat(48));
  assertEquals(r.success, false);
});

Deno.test("PgpFingerprintSchema: rejects a short key-id (16 hex)", () => {
  const r = PgpFingerprintSchema.safeParse("A".repeat(16));
  assertEquals(r.success, false);
});

Deno.test("PgpFingerprintSchema: rejects spaces (the gpg human-format)", () => {
  const r = PgpFingerprintSchema.safeParse(
    "ABAF 11C6 5A29 70B1 30AB  E3C4 79BE 3E43 0041 1886",
  );
  assertEquals(r.success, false);
});
