import { contentTypeFromPath } from "./s3_utils.ts";

// Re-export so s3.ts can import everything from one place
export { buildKey, contentTypeFromPath } from "./s3_utils.ts";

/** Options for creating an S3 client. */
export interface ClientOptions {
  region: string;
  awsProfile?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
}

/**
 * Create an S3Client with shared configuration.
 * Dynamically imports @aws-sdk/client-s3 to keep the module portable.
 */
export async function createClient(opts: ClientOptions) {
  if (opts.awsProfile) {
    Deno.env.set("AWS_PROFILE", opts.awsProfile);
  }
  const { S3Client } = await import("npm:@aws-sdk/client-s3@3");
  const config: Record<string, unknown> = { region: opts.region };
  if (opts.endpoint) config.endpoint = opts.endpoint;
  if (opts.forcePathStyle) config.forcePathStyle = true;
  return new S3Client(config);
}

/**
 * Resolve the effective bucket: method arg wins, then globalArgs fallback.
 * Throws if neither is set.
 */
export function resolveBucket(
  methodBucket: string | undefined,
  globalBucket: string | undefined,
): string {
  const bucket = methodBucket || globalBucket;
  if (!bucket) {
    throw new Error(
      "No bucket specified. Provide a bucket argument or set bucket in globalArguments.",
    );
  }
  return bucket;
}

/**
 * Resolve the effective object key, prepending the global prefix if set.
 */
export function resolveKey(key: string, prefix?: string): string {
  if (!prefix) return key;
  const clean = prefix.replace(/^\/+|\/+$/g, "");
  if (!clean) return key;
  // Avoid double-slash if key already starts with prefix
  return `${clean}/${key}`;
}

/**
 * Drain an SDK response body stream into a Uint8Array.
 * Handles the common cases: Uint8Array passthrough, string encoding,
 * and ReadableStream/AsyncIterable draining.
 */
export async function streamToBytes(
  body: unknown,
): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof ReadableStream) {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }
  // AsyncIterable (Node-style streams from AWS SDK)
  if (
    body &&
    typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] ===
      "function"
  ) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      chunks.push(
        chunk instanceof Uint8Array
          ? chunk
          : new TextEncoder().encode(String(chunk)),
      );
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }
  throw new Error("Unsupported body type from GetObject response");
}

/** Fields common to SDK object-level responses. */
export interface SdkObjectMeta {
  ETag?: string;
  ContentLength?: number;
  ContentType?: string;
  LastModified?: Date | string;
  VersionId?: string;
  StorageClass?: string;
}

/**
 * Normalize SDK response metadata into our `object` resource shape.
 */
export function normalizeObjectMeta(
  bucket: string,
  key: string,
  meta: SdkObjectMeta,
): Record<string, unknown> {
  return {
    bucket,
    key,
    etag: meta.ETag?.replace(/"/g, "") ?? null,
    size: meta.ContentLength ?? null,
    contentType: meta.ContentType ?? contentTypeFromPath(key),
    lastModified: meta.LastModified
      ? (meta.LastModified instanceof Date
        ? meta.LastModified.toISOString()
        : String(meta.LastModified))
      : null,
    versionId: meta.VersionId ?? null,
    storageClass: meta.StorageClass ?? null,
  };
}

/** Convert AWS SDK TagSet `[{Key, Value}]` → `Record<string, string>`. */
export function tagSetToRecord(
  tagSet: Array<{ Key?: string; Value?: string }>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const tag of tagSet) {
    if (tag.Key != null) {
      result[tag.Key] = tag.Value ?? "";
    }
  }
  return result;
}

/** Convert `Record<string, string>` → AWS SDK TagSet `[{Key, Value}]`. */
export function recordToTagSet(
  record: Record<string, string>,
): Array<{ Key: string; Value: string }> {
  return Object.entries(record).map(([Key, Value]) => ({ Key, Value }));
}
