/**
 * Minimal AWS Signature V4 request signing using crypto.subtle.
 * Only covers the subset needed for S3 ListBuckets (simple GET requests).
 * No external dependencies.
 */

const encoder = new TextEncoder();

async function hmacSha256(
  key: ArrayBuffer,
  data: string,
): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data));
}

async function sha256Hex(data: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(data));
  return hexEncode(hash);
}

function hexEncode(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** AWS credentials for signing. */
export interface SigningCredentials {
  accessKey: string;
  secretKey: string;
  sessionToken?: string;
}

/**
 * Sign an HTTP request with AWS Signature V4.
 * Mutates and returns the provided headers with Authorization and date headers.
 */
export async function signRequest(
  method: string,
  url: URL,
  headers: Headers,
  body: string,
  creds: SigningCredentials,
  region: string,
  service: string,
): Promise<Headers> {
  const now = new Date();
  const dateStamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 8);
  const amzDate = dateStamp + "T" +
    now.toISOString().replace(/[-:T]/g, "").slice(8, 14) + "Z";

  headers.set("x-amz-date", amzDate);
  headers.set("host", url.host);
  if (creds.sessionToken) {
    headers.set("x-amz-security-token", creds.sessionToken);
  }

  // Canonical request
  const payloadHash = await sha256Hex(body);
  headers.set("x-amz-content-sha256", payloadHash);

  const signedHeaderNames = [...headers.keys()].sort();
  const signedHeadersStr = signedHeaderNames.join(";");

  const canonicalHeaders = signedHeaderNames
    .map((k) => `${k}:${headers.get(k)!.trim()}`)
    .join("\n") + "\n";

  const canonicalPath = url.pathname || "/";
  const canonicalQuery = url.searchParams.toString();

  const canonicalRequest = [
    method,
    canonicalPath,
    canonicalQuery,
    canonicalHeaders,
    signedHeadersStr,
    payloadHash,
  ].join("\n");

  // String to sign
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  // Signing key
  const kDate = await hmacSha256(
    encoder.encode("AWS4" + creds.secretKey).buffer as ArrayBuffer,
    dateStamp,
  );
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  const kSigning = await hmacSha256(kService, "aws4_request");

  // Signature
  const signature = hexEncode(
    await crypto.subtle.sign(
      "HMAC",
      await crypto.subtle.importKey(
        "raw",
        kSigning,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      ),
      encoder.encode(stringToSign),
    ),
  );

  headers.set(
    "Authorization",
    `AWS4-HMAC-SHA256 Credential=${creds.accessKey}/${scope}, SignedHeaders=${signedHeadersStr}, Signature=${signature}`,
  );

  return headers;
}
