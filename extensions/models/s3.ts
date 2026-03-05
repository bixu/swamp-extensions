import { z } from "npm:zod@4";
import {
  contentTypeFromPath,
  getClientForBucket,
  listAllBuckets,
  normalizeObjectMeta,
  resolveBucket,
  resolveKey,
} from "./s3_helpers.ts";
import { buildKey } from "./s3_utils.ts";

// Re-export for consumers (e.g. instagram.ts imports from s3_utils.ts directly)
export { buildKey, contentTypeFromPath };

const GlobalArgsSchema = z.object({
  bucket: z
    .string()
    .optional()
    .describe("Default S3 bucket name (can be overridden per method)"),
  region: z.string().default("us-east-1").describe("AWS region"),
  awsProfile: z
    .string()
    .optional()
    .describe("AWS profile name for SSO/credential-based auth"),
  prefix: z
    .string()
    .optional()
    .describe("Optional key prefix prepended to all keys (e.g. 'uploads/')"),
  endpoint: z
    .string()
    .optional()
    .describe(
      "Custom S3 endpoint URL for S3-compatible stores (MinIO, R2, Tigris)",
    ),
  forcePathStyle: z
    .boolean()
    .optional()
    .describe("Use path-style URLs (required by some S3-compatible stores)"),
});

// --- Resource schemas ---

const ObjectSchema = z.object({
  bucket: z.string(),
  key: z.string(),
  etag: z.string().nullable(),
  size: z.number().nullable(),
  contentType: z.string().nullable(),
  lastModified: z.string().nullable(),
  versionId: z.string().nullable(),
  storageClass: z.string().nullable(),
});

const ListingSchema = z.object({
  bucket: z.string(),
  prefix: z.string().nullable(),
  count: z.number(),
  objects: z.array(z.any()),
  truncated: z.boolean(),
});

const BucketInfoSchema = z.object({
  name: z.string(),
  location: z.string().nullable(),
  creationDate: z.string().nullable(),
});

const PresignedUrlSchema = z.object({
  bucket: z.string(),
  key: z.string(),
  url: z.string(),
  method: z.string(),
  expiresIn: z.number(),
  generatedAt: z.string(),
});

// --- Shared argument fragments ---

const BucketArg = z.string().optional().describe(
  "Override the global bucket for this operation",
);

/** Helper to get a client bound to the resolved bucket. */
// deno-lint-ignore no-explicit-any
async function clientForMethod(ga: any, bucket: string) {
  return await getClientForBucket(
    {
      region: ga.region,
      awsProfile: ga.awsProfile,
      endpoint: ga.endpoint,
      forcePathStyle: ga.forcePathStyle,
      bucket,
    },
    bucket,
  );
}

export const model = {
  type: "@bixu/s3",
  version: "2026.03.05.2",
  globalArguments: GlobalArgsSchema,
  resources: {
    object: {
      description: "S3 object metadata",
      schema: ObjectSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    listing: {
      description: "S3 object listing",
      schema: ListingSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    bucketInfo: {
      description: "S3 bucket information",
      schema: BucketInfoSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    presignedUrl: {
      description: "Pre-signed S3 URL",
      schema: PresignedUrlSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    // ── Tier 1: Core Object Operations ──────────────────────────────

    put: {
      description:
        "Upload an object to S3 from a local file path or inline body string",
      arguments: z.object({
        key: z.string().describe("S3 object key"),
        file: z.string().optional().describe("Local file path to upload"),
        body: z.string().optional().describe(
          "Inline string body (used when file is not provided)",
        ),
        bucket: BucketArg,
        contentType: z.string().optional().describe(
          "Content-Type (auto-detected from key if omitted)",
        ),
        metadata: z
          .record(z.string(), z.string())
          .optional()
          .describe("User metadata key-value pairs"),
      }),
      // deno-lint-ignore no-explicit-any
      execute: async (args: any, context: any) => {
        const ga = context.globalArgs;
        const bucket = resolveBucket(args.bucket, ga.bucket);
        const client = await clientForMethod(ga, bucket);
        const key = resolveKey(args.key, ga.prefix);
        const ct = args.contentType || contentTypeFromPath(key);

        let uploadBody: Uint8Array | string;
        if (args.file) {
          uploadBody = await Deno.readFile(args.file);
        } else if (args.body != null) {
          uploadBody = args.body;
        } else {
          throw new Error("Either file or body must be provided");
        }

        context.logger.info(`Uploading to s3://${bucket}/${key}`);

        const resp = await client.putObject(key, uploadBody, {
          metadata: args.metadata,
          type: ct,
        });

        const data = normalizeObjectMeta(bucket, key, {
          etag: resp.etag,
          contentType: ct,
          versionId: resp.versionId,
          size: typeof uploadBody === "string"
            ? uploadBody.length
            : uploadBody.byteLength,
        });
        const handle = await context.writeResource("object", key, data);
        return { dataHandles: [handle] };
      },
    },

    get: {
      description:
        "Download an S3 object. Saves to a local file if file is provided, otherwise returns the body",
      arguments: z.object({
        key: z.string().describe("S3 object key"),
        file: z.string().optional().describe(
          "Local file path to save the object to",
        ),
        bucket: BucketArg,
        versionId: z.string().optional().describe(
          "Specific version ID to retrieve",
        ),
      }),
      // deno-lint-ignore no-explicit-any
      execute: async (args: any, context: any) => {
        const ga = context.globalArgs;
        const bucket = resolveBucket(args.bucket, ga.bucket);
        const client = await clientForMethod(ga, bucket);
        const key = resolveKey(args.key, ga.prefix);

        context.logger.info(`Getting s3://${bucket}/${key}`);
        const resp = await client.getObject(key, {
          versionId: args.versionId,
        });

        if (args.file) {
          const bytes = new Uint8Array(await resp.arrayBuffer());
          await Deno.writeFile(args.file, bytes);
          context.logger.info(`Saved to ${args.file}`);
        }

        const data = normalizeObjectMeta(bucket, key, {
          etag: resp.headers.get("etag") ?? undefined,
          size: Number(resp.headers.get("content-length")) || undefined,
          contentType: resp.headers.get("content-type") ?? undefined,
          versionId: resp.headers.get("x-amz-version-id") ?? undefined,
        });
        const handle = await context.writeResource("object", key, data);
        return { dataHandles: [handle] };
      },
    },

    head: {
      description: "Get metadata for an S3 object without downloading it",
      arguments: z.object({
        key: z.string().describe("S3 object key"),
        bucket: BucketArg,
        versionId: z.string().optional().describe("Specific version ID"),
      }),
      // deno-lint-ignore no-explicit-any
      execute: async (args: any, context: any) => {
        const ga = context.globalArgs;
        const bucket = resolveBucket(args.bucket, ga.bucket);
        const client = await clientForMethod(ga, bucket);
        const key = resolveKey(args.key, ga.prefix);

        context.logger.info(`HEAD s3://${bucket}/${key}`);
        const stat = await client.statObject(key, {
          versionId: args.versionId,
        });

        const data = normalizeObjectMeta(bucket, key, {
          etag: stat.etag,
          size: stat.size,
          lastModified: stat.lastModified,
          versionId: stat.versionId,
        });
        const handle = await context.writeResource("object", key, data);
        return { dataHandles: [handle] };
      },
    },

    delete: {
      description:
        "Delete one or more S3 objects. Pass key for a single object or keys for batch delete",
      arguments: z.object({
        key: z.string().optional().describe(
          "Single object key to delete",
        ),
        keys: z.array(z.string()).optional().describe(
          "Array of object keys for batch delete",
        ),
        bucket: BucketArg,
      }),
      // deno-lint-ignore no-explicit-any
      execute: async (args: any, context: any) => {
        const ga = context.globalArgs;
        const bucket = resolveBucket(args.bucket, ga.bucket);
        const client = await clientForMethod(ga, bucket);

        if (args.keys && args.keys.length > 0) {
          context.logger.info(
            `Deleting ${args.keys.length} objects from s3://${bucket}`,
          );
          for (const k of args.keys) {
            const key = resolveKey(k, ga.prefix);
            await client.deleteObject(key);
          }
        } else if (args.key) {
          const key = resolveKey(args.key, ga.prefix);
          context.logger.info(`Deleting s3://${bucket}/${key}`);
          await client.deleteObject(key);
        } else {
          throw new Error("Either key or keys must be provided");
        }

        return { dataHandles: [] };
      },
    },

    copy: {
      description: "Copy an S3 object to a new location",
      arguments: z.object({
        sourceKey: z.string().describe("Source object key"),
        destinationKey: z.string().describe("Destination object key"),
        sourceBucket: z.string().optional().describe(
          "Source bucket (defaults to global bucket)",
        ),
        destinationBucket: z.string().optional().describe(
          "Destination bucket (defaults to global bucket)",
        ),
      }),
      // deno-lint-ignore no-explicit-any
      execute: async (args: any, context: any) => {
        const ga = context.globalArgs;
        const srcBucket = resolveBucket(args.sourceBucket, ga.bucket);
        const dstBucket = resolveBucket(args.destinationBucket, ga.bucket);
        const client = await clientForMethod(ga, dstBucket);
        const srcKey = resolveKey(args.sourceKey, ga.prefix);
        const dstKey = resolveKey(args.destinationKey, ga.prefix);

        context.logger.info(
          `Copying s3://${srcBucket}/${srcKey} → s3://${dstBucket}/${dstKey}`,
        );

        const resp = await client.copyObject(
          { sourceBucketName: srcBucket, sourceKey: srcKey },
          dstKey,
        );

        const data = normalizeObjectMeta(dstBucket, dstKey, {
          etag: resp.etag,
          lastModified: resp.lastModified,
        });
        const handle = await context.writeResource("object", dstKey, data);
        return { dataHandles: [handle] };
      },
    },

    list: {
      description:
        "List objects in an S3 bucket with optional prefix filtering",
      arguments: z.object({
        prefix: z.string().optional().describe(
          "Filter by key prefix (combined with global prefix)",
        ),
        delimiter: z.string().optional().describe(
          "Delimiter for grouping (e.g. '/' for directory-like listing)",
        ),
        maxKeys: z.number().optional().describe(
          "Maximum number of keys to return (default 1000)",
        ),
        bucket: BucketArg,
      }),
      // deno-lint-ignore no-explicit-any
      execute: async (args: any, context: any) => {
        const ga = context.globalArgs;
        const bucket = resolveBucket(args.bucket, ga.bucket);
        const client = await clientForMethod(ga, bucket);
        const prefix = args.prefix
          ? resolveKey(args.prefix, ga.prefix)
          : (ga.prefix || undefined);

        context.logger.info(
          `Listing s3://${bucket}/${prefix || ""}`,
        );

        const maxKeys = args.maxKeys || 1000;

        if (args.delimiter) {
          // Use listObjectsGrouped for delimiter support
          const objects: Record<string, unknown>[] = [];
          for await (
            const item of client.listObjectsGrouped({
              prefix,
              delimiter: args.delimiter,
              pageSize: maxKeys,
            })
          ) {
            if (item.type === "Object") {
              objects.push({
                key: item.key,
                size: item.size,
                lastModified: item.lastModified
                  ? item.lastModified.toISOString()
                  : null,
                etag: item.etag?.replace(/"/g, "") ?? null,
                storageClass: null,
              });
            } else {
              // CommonPrefix
              objects.push({
                key: item.prefix,
                size: null,
                lastModified: null,
                etag: null,
                storageClass: null,
                isPrefix: true,
              });
            }
            if (objects.length >= maxKeys) break;
          }

          const data = {
            bucket,
            prefix: prefix || null,
            count: objects.length,
            objects,
            truncated: objects.length >= maxKeys,
          };
          const instanceName = prefix
            ? `list-${prefix.replace(/\//g, "-")}`
            : "list";
          const handle = await context.writeResource(
            "listing",
            instanceName,
            data,
          );
          return { dataHandles: [handle] };
        }

        // Simple flat listing
        const objects: Record<string, unknown>[] = [];
        for await (
          const obj of client.listObjects({ prefix, maxResults: maxKeys })
        ) {
          objects.push({
            key: obj.key,
            size: obj.size,
            lastModified: obj.lastModified
              ? obj.lastModified.toISOString()
              : null,
            etag: obj.etag?.replace(/"/g, "") ?? null,
            storageClass: null,
          });
        }

        const data = {
          bucket,
          prefix: prefix || null,
          count: objects.length,
          objects,
          truncated: objects.length >= maxKeys,
        };
        const instanceName = prefix
          ? `list-${prefix.replace(/\//g, "-")}`
          : "list";
        const handle = await context.writeResource(
          "listing",
          instanceName,
          data,
        );
        return { dataHandles: [handle] };
      },
    },

    presign: {
      description: "Generate a pre-signed URL for an S3 object (GET or PUT)",
      arguments: z.object({
        key: z.string().describe("S3 object key"),
        method: z
          .enum(["GET", "PUT"])
          .default("GET")
          .describe("HTTP method for the pre-signed URL"),
        expiresIn: z
          .number()
          .default(3600)
          .describe("URL expiry in seconds (default 3600)"),
        bucket: BucketArg,
      }),
      // deno-lint-ignore no-explicit-any
      execute: async (args: any, context: any) => {
        const ga = context.globalArgs;
        const bucket = resolveBucket(args.bucket, ga.bucket);
        const client = await clientForMethod(ga, bucket);
        const key = resolveKey(args.key, ga.prefix);

        const url = await client.getPresignedUrl(args.method, key, {
          expirySeconds: args.expiresIn,
        });

        context.logger.info(
          `Pre-signed ${args.method} URL for s3://${bucket}/${key}`,
        );

        const data = {
          bucket,
          key,
          url,
          method: args.method,
          expiresIn: args.expiresIn,
          generatedAt: new Date().toISOString(),
        };
        const handle = await context.writeResource(
          "presignedUrl",
          key,
          data,
        );
        return { dataHandles: [handle] };
      },
    },

    // ── Tier 2: Bucket Operations ───────────────────────────────────

    listBuckets: {
      description: "List all S3 buckets in the account",
      arguments: z.object({}),
      // deno-lint-ignore no-explicit-any
      execute: async (_args: any, context: any) => {
        const ga = context.globalArgs;

        context.logger.info("Listing all S3 buckets");
        const buckets = await listAllBuckets(ga);

        const handles = [];
        for (const b of buckets) {
          const data = {
            name: b.name,
            location: null,
            creationDate: b.creationDate ? b.creationDate.toISOString() : null,
          };
          const handle = await context.writeResource(
            "bucketInfo",
            b.name,
            data,
          );
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    createBucket: {
      description: "Create a new S3 bucket",
      arguments: z.object({
        bucket: z.string().describe("Bucket name to create"),
      }),
      // deno-lint-ignore no-explicit-any
      execute: async (args: any, context: any) => {
        const ga = context.globalArgs;
        const client = await clientForMethod(ga, args.bucket);

        context.logger.info(`Creating bucket ${args.bucket}`);
        await client.makeBucket(args.bucket);

        const data = {
          name: args.bucket,
          location: ga.region || "us-east-1",
          creationDate: new Date().toISOString(),
        };
        const handle = await context.writeResource(
          "bucketInfo",
          args.bucket,
          data,
        );
        return { dataHandles: [handle] };
      },
    },

    deleteBucket: {
      description: "Delete an S3 bucket (must be empty)",
      arguments: z.object({
        bucket: z.string().describe("Bucket name to delete"),
      }),
      // deno-lint-ignore no-explicit-any
      execute: async (args: any, context: any) => {
        const ga = context.globalArgs;
        const client = await clientForMethod(ga, args.bucket);

        context.logger.info(`Deleting bucket ${args.bucket}`);
        await client.removeBucket(args.bucket);

        return { dataHandles: [] };
      },
    },

    headBucket: {
      description: "Check if a bucket exists and you have access",
      arguments: z.object({
        bucket: z.string().optional().describe(
          "Bucket name (defaults to global bucket)",
        ),
      }),
      // deno-lint-ignore no-explicit-any
      execute: async (args: any, context: any) => {
        const ga = context.globalArgs;
        const bucket = resolveBucket(args.bucket, ga.bucket);
        const client = await clientForMethod(ga, bucket);

        context.logger.info(`HEAD bucket ${bucket}`);
        const exists = await client.bucketExists(bucket);
        if (!exists) {
          throw new Error(
            `Bucket "${bucket}" does not exist or is not accessible`,
          );
        }

        const data = {
          name: bucket,
          location: ga.region || "us-east-1",
          creationDate: null,
        };
        const handle = await context.writeResource(
          "bucketInfo",
          bucket,
          data,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
