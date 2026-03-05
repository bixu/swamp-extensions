import { z } from "npm:zod@4";
import {
  contentTypeFromPath,
  createClient,
  normalizeObjectMeta,
  recordToTagSet,
  resolveBucket,
  resolveKey,
  streamToBytes,
  tagSetToRecord,
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

const CommandResultSchema = z.object({
  command: z.string(),
  metadata: z.any(),
  output: z.any(),
});

// --- Shared argument fragments ---

const BucketArg = z.string().optional().describe(
  "Override the global bucket for this operation",
);

export const model = {
  type: "@bixu/s3",
  version: "2026.03.05.1",
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
    commandResult: {
      description: "Result from a generic SDK command",
      schema: CommandResultSchema,
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
        storageClass: z.string().optional().describe(
          "Storage class (STANDARD, INTELLIGENT_TIERING, GLACIER, etc.)",
        ),
      }),
      execute: async (args, context) => {
        const { PutObjectCommand } = await import(
          "npm:@aws-sdk/client-s3@3"
        );
        const ga = context.globalArgs;
        const client = await createClient(ga);
        const bucket = resolveBucket(args.bucket, ga.bucket);
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

        const params: Record<string, unknown> = {
          Bucket: bucket,
          Key: key,
          Body: uploadBody,
          ContentType: ct,
        };
        if (args.metadata) params.Metadata = args.metadata;
        if (args.storageClass) params.StorageClass = args.storageClass;

        const resp = await client.send(new PutObjectCommand(params));

        const data = normalizeObjectMeta(bucket, key, {
          ETag: resp.ETag,
          ContentType: ct,
          VersionId: resp.VersionId,
          StorageClass: args.storageClass,
          ContentLength: typeof uploadBody === "string"
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
      execute: async (args, context) => {
        const { GetObjectCommand } = await import(
          "npm:@aws-sdk/client-s3@3"
        );
        const ga = context.globalArgs;
        const client = await createClient(ga);
        const bucket = resolveBucket(args.bucket, ga.bucket);
        const key = resolveKey(args.key, ga.prefix);

        const params: Record<string, unknown> = { Bucket: bucket, Key: key };
        if (args.versionId) params.VersionId = args.versionId;

        context.logger.info(`Getting s3://${bucket}/${key}`);
        const resp = await client.send(new GetObjectCommand(params));

        const bytes = await streamToBytes(resp.Body);
        if (args.file) {
          await Deno.writeFile(args.file, bytes);
          context.logger.info(`Saved to ${args.file}`);
        }

        const data = normalizeObjectMeta(bucket, key, resp);
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
      execute: async (args, context) => {
        const { HeadObjectCommand } = await import(
          "npm:@aws-sdk/client-s3@3"
        );
        const ga = context.globalArgs;
        const client = await createClient(ga);
        const bucket = resolveBucket(args.bucket, ga.bucket);
        const key = resolveKey(args.key, ga.prefix);

        const params: Record<string, unknown> = { Bucket: bucket, Key: key };
        if (args.versionId) params.VersionId = args.versionId;

        context.logger.info(`HEAD s3://${bucket}/${key}`);
        const resp = await client.send(new HeadObjectCommand(params));

        const data = normalizeObjectMeta(bucket, key, resp);
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
      execute: async (args, context) => {
        const { DeleteObjectCommand, DeleteObjectsCommand } = await import(
          "npm:@aws-sdk/client-s3@3"
        );
        const ga = context.globalArgs;
        const client = await createClient(ga);
        const bucket = resolveBucket(args.bucket, ga.bucket);

        if (args.keys && args.keys.length > 0) {
          const objects = args.keys.map((k) => ({
            Key: resolveKey(k, ga.prefix),
          }));
          context.logger.info(
            `Deleting ${objects.length} objects from s3://${bucket}`,
          );
          await client.send(
            new DeleteObjectsCommand({
              Bucket: bucket,
              Delete: { Objects: objects },
            }),
          );
        } else if (args.key) {
          const key = resolveKey(args.key, ga.prefix);
          context.logger.info(`Deleting s3://${bucket}/${key}`);
          await client.send(
            new DeleteObjectCommand({ Bucket: bucket, Key: key }),
          );
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
      execute: async (args, context) => {
        const { CopyObjectCommand } = await import(
          "npm:@aws-sdk/client-s3@3"
        );
        const ga = context.globalArgs;
        const client = await createClient(ga);
        const srcBucket = resolveBucket(args.sourceBucket, ga.bucket);
        const dstBucket = resolveBucket(args.destinationBucket, ga.bucket);
        const srcKey = resolveKey(args.sourceKey, ga.prefix);
        const dstKey = resolveKey(args.destinationKey, ga.prefix);

        context.logger.info(
          `Copying s3://${srcBucket}/${srcKey} → s3://${dstBucket}/${dstKey}`,
        );

        const resp = await client.send(
          new CopyObjectCommand({
            Bucket: dstBucket,
            Key: dstKey,
            CopySource: `${srcBucket}/${srcKey}`,
          }),
        );

        const data = normalizeObjectMeta(dstBucket, dstKey, {
          ETag: resp.CopyObjectResult?.ETag,
          LastModified: resp.CopyObjectResult?.LastModified,
          VersionId: resp.VersionId,
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
        startAfter: z.string().optional().describe(
          "Start listing after this key",
        ),
        bucket: BucketArg,
      }),
      execute: async (args, context) => {
        const { ListObjectsV2Command } = await import(
          "npm:@aws-sdk/client-s3@3"
        );
        const ga = context.globalArgs;
        const client = await createClient(ga);
        const bucket = resolveBucket(args.bucket, ga.bucket);
        const prefix = args.prefix
          ? resolveKey(args.prefix, ga.prefix)
          : (ga.prefix || undefined);

        const params: Record<string, unknown> = { Bucket: bucket };
        if (prefix) params.Prefix = prefix;
        if (args.delimiter) params.Delimiter = args.delimiter;
        if (args.maxKeys) params.MaxKeys = args.maxKeys;
        if (args.startAfter) params.StartAfter = args.startAfter;

        context.logger.info(
          `Listing s3://${bucket}/${prefix || ""}`,
        );
        const resp = await client.send(new ListObjectsV2Command(params));

        const objects = (resp.Contents || []).map(
          (obj: Record<string, unknown>) => ({
            key: obj.Key,
            size: obj.Size,
            lastModified: obj.LastModified instanceof Date
              ? obj.LastModified.toISOString()
              : obj.LastModified ?? null,
            etag: typeof obj.ETag === "string"
              ? obj.ETag.replace(/"/g, "")
              : null,
            storageClass: obj.StorageClass ?? null,
          }),
        );

        const data = {
          bucket,
          prefix: prefix || null,
          count: objects.length,
          objects,
          truncated: resp.IsTruncated ?? false,
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
      execute: async (args, context) => {
        const { GetObjectCommand, PutObjectCommand } = await import(
          "npm:@aws-sdk/client-s3@3"
        );
        const { getSignedUrl } = await import(
          "npm:@aws-sdk/s3-request-presigner@3"
        );
        const ga = context.globalArgs;
        const client = await createClient(ga);
        const bucket = resolveBucket(args.bucket, ga.bucket);
        const key = resolveKey(args.key, ga.prefix);

        const command = args.method === "PUT"
          ? new PutObjectCommand({ Bucket: bucket, Key: key })
          : new GetObjectCommand({ Bucket: bucket, Key: key });

        const url = await getSignedUrl(client, command, {
          expiresIn: args.expiresIn,
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
      execute: async (_args, context) => {
        const { ListBucketsCommand } = await import(
          "npm:@aws-sdk/client-s3@3"
        );
        const ga = context.globalArgs;
        const client = await createClient(ga);

        context.logger.info("Listing all S3 buckets");
        const resp = await client.send(new ListBucketsCommand({}));

        const handles = [];
        for (const b of resp.Buckets || []) {
          const data = {
            name: b.Name,
            location: null,
            creationDate: b.CreationDate instanceof Date
              ? b.CreationDate.toISOString()
              : b.CreationDate ?? null,
          };
          const handle = await context.writeResource(
            "bucketInfo",
            b.Name,
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
        locationConstraint: z.string().optional().describe(
          "Region constraint (e.g. 'eu-west-1'). Defaults to the client region",
        ),
      }),
      execute: async (args, context) => {
        const { CreateBucketCommand } = await import(
          "npm:@aws-sdk/client-s3@3"
        );
        const ga = context.globalArgs;
        const client = await createClient(ga);

        const params: Record<string, unknown> = { Bucket: args.bucket };
        if (args.locationConstraint) {
          params.CreateBucketConfiguration = {
            LocationConstraint: args.locationConstraint,
          };
        }

        context.logger.info(`Creating bucket ${args.bucket}`);
        await client.send(new CreateBucketCommand(params));

        const data = {
          name: args.bucket,
          location: args.locationConstraint || ga.region || "us-east-1",
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
      execute: async (args, context) => {
        const { DeleteBucketCommand } = await import(
          "npm:@aws-sdk/client-s3@3"
        );
        const ga = context.globalArgs;
        const client = await createClient(ga);

        context.logger.info(`Deleting bucket ${args.bucket}`);
        await client.send(
          new DeleteBucketCommand({ Bucket: args.bucket }),
        );

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
      execute: async (args, context) => {
        const { HeadBucketCommand } = await import(
          "npm:@aws-sdk/client-s3@3"
        );
        const ga = context.globalArgs;
        const client = await createClient(ga);
        const bucket = resolveBucket(args.bucket, ga.bucket);

        context.logger.info(`HEAD bucket ${bucket}`);
        await client.send(new HeadBucketCommand({ Bucket: bucket }));

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

    // ── Tier 3: Versioning & Tagging ────────────────────────────────

    listVersions: {
      description: "List object versions in a bucket",
      arguments: z.object({
        prefix: z.string().optional().describe("Filter by key prefix"),
        maxKeys: z.number().optional().describe("Maximum number of versions"),
        bucket: BucketArg,
      }),
      execute: async (args, context) => {
        const { ListObjectVersionsCommand } = await import(
          "npm:@aws-sdk/client-s3@3"
        );
        const ga = context.globalArgs;
        const client = await createClient(ga);
        const bucket = resolveBucket(args.bucket, ga.bucket);
        const prefix = args.prefix
          ? resolveKey(args.prefix, ga.prefix)
          : (ga.prefix || undefined);

        const params: Record<string, unknown> = { Bucket: bucket };
        if (prefix) params.Prefix = prefix;
        if (args.maxKeys) params.MaxKeys = args.maxKeys;

        context.logger.info(
          `Listing versions in s3://${bucket}/${prefix || ""}`,
        );
        const resp = await client.send(
          new ListObjectVersionsCommand(params),
        );

        const objects = (resp.Versions || []).map(
          (v: Record<string, unknown>) => ({
            key: v.Key,
            versionId: v.VersionId,
            size: v.Size,
            lastModified: v.LastModified instanceof Date
              ? v.LastModified.toISOString()
              : v.LastModified ?? null,
            isLatest: v.IsLatest ?? false,
            etag: typeof v.ETag === "string" ? v.ETag.replace(/"/g, "") : null,
          }),
        );

        const data = {
          bucket,
          prefix: prefix || null,
          count: objects.length,
          objects,
          truncated: resp.IsTruncated ?? false,
        };
        const instanceName = prefix
          ? `versions-${prefix.replace(/\//g, "-")}`
          : "versions";
        const handle = await context.writeResource(
          "listing",
          instanceName,
          data,
        );
        return { dataHandles: [handle] };
      },
    },

    getTagging: {
      description:
        "Get tags for an object or bucket. Provide key for object tags, omit for bucket tags",
      arguments: z.object({
        key: z.string().optional().describe(
          "Object key (omit for bucket-level tags)",
        ),
        bucket: BucketArg,
      }),
      execute: async (args, context) => {
        const { GetObjectTaggingCommand, GetBucketTaggingCommand } =
          await import("npm:@aws-sdk/client-s3@3");
        const ga = context.globalArgs;
        const client = await createClient(ga);
        const bucket = resolveBucket(args.bucket, ga.bucket);

        let tags: Record<string, string>;
        if (args.key) {
          const key = resolveKey(args.key, ga.prefix);
          context.logger.info(
            `Getting tags for s3://${bucket}/${key}`,
          );
          const resp = await client.send(
            new GetObjectTaggingCommand({ Bucket: bucket, Key: key }),
          );
          tags = tagSetToRecord(resp.TagSet || []);
        } else {
          context.logger.info(`Getting tags for bucket ${bucket}`);
          const resp = await client.send(
            new GetBucketTaggingCommand({ Bucket: bucket }),
          );
          tags = tagSetToRecord(resp.TagSet || []);
        }

        const data = {
          command: args.key ? "GetObjectTagging" : "GetBucketTagging",
          metadata: { bucket, key: args.key || null },
          output: tags,
        };
        const instanceName = args.key ? `tags-${args.key}` : "bucket-tags";
        const handle = await context.writeResource(
          "commandResult",
          instanceName,
          data,
        );
        return { dataHandles: [handle] };
      },
    },

    putTagging: {
      description:
        "Set tags on an object or bucket. Provide key for object tags, omit for bucket tags",
      arguments: z.object({
        key: z.string().optional().describe(
          "Object key (omit for bucket-level tags)",
        ),
        tags: z
          .record(z.string(), z.string())
          .describe("Tag key-value pairs"),
        bucket: BucketArg,
      }),
      execute: async (args, context) => {
        const { PutObjectTaggingCommand, PutBucketTaggingCommand } =
          await import("npm:@aws-sdk/client-s3@3");
        const ga = context.globalArgs;
        const client = await createClient(ga);
        const bucket = resolveBucket(args.bucket, ga.bucket);
        const tagSet = recordToTagSet(args.tags);

        if (args.key) {
          const key = resolveKey(args.key, ga.prefix);
          context.logger.info(
            `Setting tags on s3://${bucket}/${key}`,
          );
          await client.send(
            new PutObjectTaggingCommand({
              Bucket: bucket,
              Key: key,
              Tagging: { TagSet: tagSet },
            }),
          );
        } else {
          context.logger.info(`Setting tags on bucket ${bucket}`);
          await client.send(
            new PutBucketTaggingCommand({
              Bucket: bucket,
              Tagging: { TagSet: tagSet },
            }),
          );
        }

        const data = {
          command: args.key ? "PutObjectTagging" : "PutBucketTagging",
          metadata: { bucket, key: args.key || null, tags: args.tags },
          output: { success: true },
        };
        const instanceName = args.key ? `tags-${args.key}` : "bucket-tags";
        const handle = await context.writeResource(
          "commandResult",
          instanceName,
          data,
        );
        return { dataHandles: [handle] };
      },
    },

    getVersioning: {
      description: "Get the versioning configuration for a bucket",
      arguments: z.object({
        bucket: BucketArg,
      }),
      execute: async (args, context) => {
        const { GetBucketVersioningCommand } = await import(
          "npm:@aws-sdk/client-s3@3"
        );
        const ga = context.globalArgs;
        const client = await createClient(ga);
        const bucket = resolveBucket(args.bucket, ga.bucket);

        context.logger.info(`Getting versioning for bucket ${bucket}`);
        const resp = await client.send(
          new GetBucketVersioningCommand({ Bucket: bucket }),
        );

        const data = {
          command: "GetBucketVersioning",
          metadata: { bucket },
          output: {
            status: resp.Status ?? "Disabled",
            mfaDelete: resp.MFADelete ?? "Disabled",
          },
        };
        const handle = await context.writeResource(
          "commandResult",
          `versioning-${bucket}`,
          data,
        );
        return { dataHandles: [handle] };
      },
    },

    // ── Escape Hatch ────────────────────────────────────────────────

    command: {
      description:
        "Execute any @aws-sdk/client-s3 command by class name. Covers all ~90 SDK commands not wrapped above",
      arguments: z.object({
        command: z.string().describe(
          "SDK command class name (e.g. 'PutBucketCorsCommand', 'GetBucketPolicyCommand')",
        ),
        input: z
          .record(z.string(), z.any())
          .default({})
          .describe("Command input object (passed directly to the SDK)"),
      }),
      execute: async (args, context) => {
        const sdk = await import("npm:@aws-sdk/client-s3@3");
        const ga = context.globalArgs;
        const client = await createClient(ga);

        const CommandClass = (sdk as Record<string, unknown>)[args.command];
        if (typeof CommandClass !== "function") {
          throw new Error(
            `Unknown SDK command: ${args.command}. ` +
              `Must be a valid @aws-sdk/client-s3 command class name.`,
          );
        }

        context.logger.info(`Executing ${args.command}`);
        const resp = await client.send(
          new (CommandClass as new (input: unknown) => unknown)(
            args.input,
          ) as never,
        );

        // Strip SDK metadata noise, keep the useful output
        const { $metadata, ...output } = resp as Record<string, unknown>;

        const data = {
          command: args.command,
          metadata: $metadata,
          output,
        };
        const handle = await context.writeResource(
          "commandResult",
          args.command,
          data,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
