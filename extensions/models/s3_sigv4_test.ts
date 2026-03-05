import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { signRequest } from "./s3_sigv4.ts";

Deno.test("signRequest sets required headers", async () => {
  const headers = await signRequest(
    "GET",
    new URL("https://s3.us-east-1.amazonaws.com/"),
    new Headers(),
    "",
    {
      accessKey: "AKIAIOSFODNN7EXAMPLE",
      secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    },
    "us-east-1",
    "s3",
  );

  assertEquals(headers.has("x-amz-date"), true);
  assertEquals(headers.has("host"), true);
  assertEquals(headers.has("Authorization"), true);
  assertEquals(headers.get("host"), "s3.us-east-1.amazonaws.com");
});

Deno.test("signRequest includes x-amz-security-token when sessionToken provided", async () => {
  const headers = await signRequest(
    "GET",
    new URL("https://s3.us-east-1.amazonaws.com/"),
    new Headers(),
    "",
    {
      accessKey: "AKIAIOSFODNN7EXAMPLE",
      secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      sessionToken: "FwoGZXIvYXdzEBYaDH+session+token",
    },
    "us-east-1",
    "s3",
  );

  assertEquals(
    headers.get("x-amz-security-token"),
    "FwoGZXIvYXdzEBYaDH+session+token",
  );
  // Token must be in signed headers (referenced in Authorization)
  const auth = headers.get("Authorization")!;
  assertEquals(auth.includes("x-amz-security-token"), true);
});

Deno.test("signRequest omits x-amz-security-token when no sessionToken", async () => {
  const headers = await signRequest(
    "GET",
    new URL("https://s3.us-east-1.amazonaws.com/"),
    new Headers(),
    "",
    {
      accessKey: "AKIAIOSFODNN7EXAMPLE",
      secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    },
    "us-east-1",
    "s3",
  );

  assertEquals(headers.has("x-amz-security-token"), false);
});

Deno.test("signRequest Authorization has correct AWS4-HMAC-SHA256 format", async () => {
  const headers = await signRequest(
    "GET",
    new URL("https://s3.us-east-1.amazonaws.com/"),
    new Headers(),
    "",
    {
      accessKey: "AKIAIOSFODNN7EXAMPLE",
      secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    },
    "us-east-1",
    "s3",
  );

  const auth = headers.get("Authorization")!;
  assertEquals(
    auth.startsWith("AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/"),
    true,
  );
  assertEquals(auth.includes("SignedHeaders="), true);
  assertEquals(auth.includes("Signature="), true);
  // Signature should be 64 hex chars
  const sig = auth.split("Signature=")[1];
  assertEquals(sig.length, 64);
  assertEquals(/^[0-9a-f]{64}$/.test(sig), true);
});
