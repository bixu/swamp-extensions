import { z } from "npm:zod@4";
import { buildKey, contentTypeFromPath } from "./s3_utils.ts";

export { buildKey, contentTypeFromPath };

const GlobalArgsSchema = z.object({
  bucket: z.string().describe("S3 bucket name"),
  region: z.string().default("us-east-1").describe("AWS region"),
  awsProfile: z
    .string()
    .optional()
    .describe("AWS profile name for SSO/credential-based auth"),
  prefix: z
    .string()
    .optional()
    .describe("Optional key prefix (e.g. 'uploads/images')"),
});

const ResultSchema = z.object({
  bucket: z.string(),
  key: z.string(),
  contentType: z.string(),
  url: z.string().describe("Pre-signed GET URL"),
  uploadedAt: z.string(),
});

export const model = {
  type: "@bixu/s3",
  version: "2026.03.04.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    result: {
      description: "Upload result with pre-signed URL",
      schema: ResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    upload: {
      description: "Upload a local file to S3 and return a pre-signed GET URL",
      arguments: z.object({
        filePath: z.string().describe("Local file path to upload"),
        key: z
          .string()
          .optional()
          .describe(
            "S3 object key. Defaults to prefix + filename",
          ),
        expiresIn: z
          .number()
          .default(3600)
          .describe("Pre-signed URL expiry in seconds (default 3600)"),
      }),
      execute: async (args, context) => {
        const { S3Client, PutObjectCommand, GetObjectCommand } = await import(
          "npm:@aws-sdk/client-s3@3"
        );
        const { getSignedUrl } = await import(
          "npm:@aws-sdk/s3-request-presigner@3"
        );

        const { bucket, region, awsProfile, prefix } = context.globalArgs;
        if (awsProfile) Deno.env.set("AWS_PROFILE", awsProfile);
        const client = new S3Client({ region });
        const key = args.key || buildKey(args.filePath, prefix);
        const ct = contentTypeFromPath(args.filePath);

        context.logger.info(
          `Uploading ${args.filePath} to s3://${bucket}/${key}`,
        );

        const body = await Deno.readFile(args.filePath);
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: body,
            ContentType: ct,
          }),
        );

        const url = await getSignedUrl(
          client,
          new GetObjectCommand({ Bucket: bucket, Key: key }),
          { expiresIn: args.expiresIn },
        );

        context.logger.info(
          `Generated pre-signed URL (expires in ${args.expiresIn}s)`,
        );

        const handle = await context.writeResource("result", "latest", {
          bucket,
          key,
          contentType: ct,
          url,
          uploadedAt: new Date().toISOString(),
        });

        return { dataHandles: [handle] };
      },
    },
    presign: {
      description: "Generate a pre-signed GET URL for an existing S3 object",
      arguments: z.object({
        key: z.string().describe("S3 object key"),
        expiresIn: z
          .number()
          .default(3600)
          .describe("Pre-signed URL expiry in seconds (default 3600)"),
      }),
      execute: async (args, context) => {
        const { S3Client, GetObjectCommand } = await import(
          "npm:@aws-sdk/client-s3@3"
        );
        const { getSignedUrl } = await import(
          "npm:@aws-sdk/s3-request-presigner@3"
        );

        const { bucket, region, awsProfile } = context.globalArgs;
        if (awsProfile) Deno.env.set("AWS_PROFILE", awsProfile);
        const client = new S3Client({ region });
        const ct = contentTypeFromPath(args.key);

        const url = await getSignedUrl(
          client,
          new GetObjectCommand({ Bucket: bucket, Key: args.key }),
          { expiresIn: args.expiresIn },
        );

        context.logger.info(
          `Generated pre-signed URL for s3://${bucket}/${args.key}`,
        );

        const handle = await context.writeResource("result", "latest", {
          bucket,
          key: args.key,
          contentType: ct,
          url,
          uploadedAt: new Date().toISOString(),
        });

        return { dataHandles: [handle] };
      },
    },
  },
};
