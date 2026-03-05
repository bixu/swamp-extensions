import { S3Client } from "jsr:@bradenmacdonald/s3-lite-client@0.7";
import { contentTypeFromPath } from "./s3_utils.ts";

// Re-export so s3.ts can import everything from one place
export { buildKey, contentTypeFromPath } from "./s3_utils.ts";

// Re-export S3Client type for consumers
export type { S3Client } from "jsr:@bradenmacdonald/s3-lite-client@0.7";

/** Strip lines that might contain credential fragments from CLI stderr. */
function sanitizeStderr(raw: string, maxLen = 500): string {
  const filtered = raw
    .split("\n")
    .filter((l) => !/secret|accesskey|token|password/i.test(l))
    .join("\n");
  return filtered.length > maxLen
    ? filtered.slice(0, maxLen) + "...(truncated)"
    : filtered;
}

/** Resolved AWS credentials. */
export interface AwsCredentials {
  accessKey: string;
  secretKey: string;
  sessionToken?: string;
}

/** Options for creating an S3 client. */
export interface ClientOptions {
  region: string;
  awsProfile?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  bucket?: string;
}

/**
 * Resolve AWS credentials from either an AWS profile (via `aws configure
 * export-credentials`) or environment variables.
 */
export async function resolveCredentials(
  awsProfile?: string,
): Promise<AwsCredentials> {
  if (awsProfile) {
    const cmd = new Deno.Command("aws", {
      args: [
        "configure",
        "export-credentials",
        "--profile",
        awsProfile,
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const result = await cmd.output();
    if (!result.success) {
      const stderr = sanitizeStderr(new TextDecoder().decode(result.stderr));
      throw new Error(
        `Failed to resolve credentials for profile "${awsProfile}": ${stderr}`,
      );
    }
    const json = JSON.parse(new TextDecoder().decode(result.stdout));
    const creds: AwsCredentials = {
      accessKey: json.AccessKeyId,
      secretKey: json.SecretAccessKey,
    };
    if (json.SessionToken) creds.sessionToken = json.SessionToken;
    return creds;
  }

  // Fall back to environment variables
  const accessKey = Deno.env.get("AWS_ACCESS_KEY_ID");
  const secretKey = Deno.env.get("AWS_SECRET_ACCESS_KEY");
  if (!accessKey || !secretKey) {
    throw new Error(
      "No AWS credentials found. Set awsProfile or AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY environment variables.",
    );
  }
  const creds: AwsCredentials = { accessKey, secretKey };
  const sessionToken = Deno.env.get("AWS_SESSION_TOKEN");
  if (sessionToken) creds.sessionToken = sessionToken;
  return creds;
}

/**
 * Create an S3Client backed by s3-lite-client with shared configuration.
 * Resolves credentials from the AWS profile or environment.
 */
export async function createClient(opts: ClientOptions): Promise<S3Client> {
  const creds = await resolveCredentials(opts.awsProfile);

  let endPoint: string;
  let useSSL = true;
  let port: number | undefined;

  if (opts.endpoint) {
    const url = new URL(opts.endpoint);
    endPoint = url.hostname;
    useSSL = url.protocol === "https:";
    if (url.port) port = Number(url.port);
  } else {
    endPoint = `s3.${opts.region}.amazonaws.com`;
  }

  return new S3Client({
    endPoint,
    region: opts.region,
    useSSL,
    port,
    bucket: opts.bucket,
    accessKey: creds.accessKey,
    secretKey: creds.secretKey,
    sessionToken: creds.sessionToken,
    pathStyle: opts.forcePathStyle,
  });
}

/** Cache of clients keyed by bucket name for bucket-switching. */
const clientCache = new Map<string, S3Client>();

/**
 * Get or create a client for the specified bucket. Caches clients to avoid
 * redundant credential resolution when switching buckets within a session.
 */
export async function getClientForBucket(
  opts: ClientOptions,
  bucket: string,
): Promise<S3Client> {
  const cacheKey = `${opts.awsProfile || ""}:${
    opts.endpoint || ""
  }:${opts.region}:${bucket}`;
  const cached = clientCache.get(cacheKey);
  if (cached) return cached;

  const client = await createClient({ ...opts, bucket });
  clientCache.set(cacheKey, client);
  return client;
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
  return `${clean}/${key}`;
}

/** Bucket info from ListBuckets API response. */
export interface BucketEntry {
  name: string;
  creationDate: Date | null;
}

/**
 * List all S3 buckets using the S3 ListBuckets API.
 * s3-lite-client doesn't have a listBuckets method, so we resolve
 * credentials and issue a signed request via `aws s3api list-buckets`.
 */
export async function listAllBuckets(
  opts: ClientOptions,
): Promise<BucketEntry[]> {
  const args = ["s3api", "list-buckets", "--output", "json"];
  if (opts.awsProfile) args.push("--profile", opts.awsProfile);
  if (opts.region) args.push("--region", opts.region);
  if (opts.endpoint) args.push("--endpoint-url", opts.endpoint);

  const cmd = new Deno.Command("aws", {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const result = await cmd.output();
  if (!result.success) {
    const stderr = sanitizeStderr(new TextDecoder().decode(result.stderr));
    throw new Error(`Failed to list buckets: ${stderr}`);
  }
  const json = JSON.parse(new TextDecoder().decode(result.stdout));
  return (json.Buckets || []).map(
    (b: { Name: string; CreationDate?: string }) => ({
      name: b.Name,
      creationDate: b.CreationDate ? new Date(b.CreationDate) : null,
    }),
  );
}

/** Fields from s3-lite-client statObject / response metadata. */
export interface LiteObjectMeta {
  etag?: string;
  size?: number;
  contentType?: string;
  lastModified?: Date | string | null;
  versionId?: string | null;
  storageClass?: string;
}

/**
 * Normalize s3-lite-client response metadata into our `object` resource shape.
 */
export function normalizeObjectMeta(
  bucket: string,
  key: string,
  meta: LiteObjectMeta,
): Record<string, unknown> {
  return {
    bucket,
    key,
    etag: meta.etag?.replace(/"/g, "") ?? null,
    size: meta.size ?? null,
    contentType: meta.contentType ?? contentTypeFromPath(key),
    lastModified: meta.lastModified
      ? (meta.lastModified instanceof Date
        ? meta.lastModified.toISOString()
        : String(meta.lastModified))
      : null,
    versionId: meta.versionId ?? null,
    storageClass: meta.storageClass ?? null,
  };
}
