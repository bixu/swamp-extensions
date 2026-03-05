import { z } from "npm:zod@4";
import { igApi, isUrl, waitForContainer } from "./instagram_helpers.ts";
import { buildKey } from "./s3_utils.ts";

export { igApi, isUrl, waitForContainer };

const GlobalArgsSchema = z.object({
  accessToken: z
    .string()
    .describe(
      "Instagram Graph API long-lived user access token. Requires instagram_business_content_publish and instagram_business_basic scopes",
    ),
  igUserId: z
    .string()
    .describe("Instagram Business or Creator account user ID"),
  s3Bucket: z
    .string()
    .optional()
    .describe(
      "S3 bucket for uploading local images. Required when posting local file paths",
    ),
  s3Region: z
    .string()
    .optional()
    .describe("AWS region for S3 bucket (default us-east-1)"),
  s3Prefix: z
    .string()
    .optional()
    .describe("S3 key prefix for uploaded images (e.g. 'instagram/uploads')"),
  awsProfile: z
    .string()
    .optional()
    .describe("AWS profile name for S3 auth"),
});

const ResultSchema = z.object({
  id: z.string().describe("Published media ID"),
  caption: z.string(),
  imageUrl: z.string(),
  publishedAt: z.string(),
});

export const model = {
  type: "@bixu/instagram",
  version: "2026.03.04.2",
  globalArguments: GlobalArgsSchema,
  resources: {
    result: {
      description: "Published post confirmation",
      schema: ResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    post: {
      description:
        "Post an image to Instagram. Accepts a public URL or a local file path (requires S3 config for local files)",
      arguments: z.object({
        image: z.string().describe(
          "Public image URL or local file path (JPEG, max 8MB)",
        ),
        caption: z.string().optional().describe("Post caption text"),
      }),
      execute: async (args, context) => {
        const accessToken = String(context.globalArgs.accessToken).trim();
        const igUserId = String(context.globalArgs.igUserId).trim();

        let imageUrl: string;

        if (isUrl(args.image)) {
          imageUrl = args.image;
        } else {
          // Local file — upload to S3 and get a pre-signed URL
          const bucket = context.globalArgs.s3Bucket;
          if (!bucket) {
            throw new Error(
              "s3Bucket is required in globalArguments when posting a local file path",
            );
          }
          const region = context.globalArgs.s3Region || "us-east-1";

          const { S3Client, PutObjectCommand, GetObjectCommand } = await import(
            "npm:@aws-sdk/client-s3@3"
          );
          const { getSignedUrl } = await import(
            "npm:@aws-sdk/s3-request-presigner@3"
          );
          const { contentTypeFromPath } = await import("./s3_utils.ts");

          if (context.globalArgs.awsProfile) {
            Deno.env.set("AWS_PROFILE", context.globalArgs.awsProfile);
          }
          const client = new S3Client({ region });
          const key = buildKey(args.image, context.globalArgs.s3Prefix);

          context.logger.info(
            `Uploading ${args.image} to s3://${bucket}/${key}`,
          );

          const body = await Deno.readFile(args.image);
          await client.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: key,
              Body: body,
              ContentType: contentTypeFromPath(args.image),
            }),
          );

          // Instagram needs about an hour to process — 3600s expiry
          imageUrl = await getSignedUrl(
            client,
            new GetObjectCommand({ Bucket: bucket, Key: key }),
            { expiresIn: 3600 },
          );
          context.logger.info("Generated pre-signed URL for Instagram");
        }

        // Step 1: Create media container
        const containerParams: Record<string, string> = {
          image_url: imageUrl,
        };
        if (args.caption) {
          containerParams.caption = args.caption;
        }

        const container = await igApi(
          `/${igUserId}/media`,
          containerParams,
          accessToken,
        );

        context.logger.info(
          `Created media container ${container.id}, waiting for processing...`,
        );

        // Step 2: Wait for container to finish processing
        await waitForContainer(container.id, accessToken);

        // Step 3: Publish
        const published = await igApi(
          `/${igUserId}/media_publish`,
          { creation_id: container.id },
          accessToken,
        );

        context.logger.info(`Published post ${published.id}`);

        const handle = await context.writeResource("result", "latest", {
          id: published.id,
          caption: args.caption || "",
          imageUrl,
          publishedAt: new Date().toISOString(),
        });

        return { dataHandles: [handle] };
      },
    },
  },
};
