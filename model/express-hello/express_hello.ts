/**
 * @module
 * Demo Express.js app that runs in Docker and serves random Wikipedia images.
 *
 * This extension builds a lightweight Express/TypeScript container and manages
 * its lifecycle (start, stop, status) through Docker. It is intended as a
 * reference implementation showing how to create a swamp extension model that
 * wraps a containerised service.
 */

import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Input validation helpers — guard against Docker flag injection and bad ports
// ---------------------------------------------------------------------------

const SAFE_CONTAINER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

function validateContainerName(name: string): void {
  if (!SAFE_CONTAINER_NAME_RE.test(name)) {
    throw new Error(
      `Invalid containerName ${
        JSON.stringify(name)
      }: must start with alphanumeric and contain only alphanumeric, underscore, hyphen, or period`,
    );
  }
}

function validatePort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `Invalid port ${port}: must be an integer between 1 and 65535`,
    );
  }
}

const GlobalArgsSchema = z.object({
  port: z.number().default(3000).describe("Host port to expose the app on"),
  containerName: z.string().default("swamp-express-hello").describe(
    "Docker container name",
  ),
});

const StateSchema = z.object({
  containerId: z.string(),
  containerName: z.string(),
  imageName: z.string(),
  port: z.number(),
  url: z.string(),
  status: z.string(),
  startedAt: z.string(),
});

async function runCmd(
  cmd: string[],
  logger: { info: (msg: string) => void; error: (msg: string) => void },
): Promise<{ stdout: string; stderr: string; code: number }> {
  logger.info(`$ ${cmd.join(" ")}`);
  const proc = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    stdout: "piped",
    stderr: "piped",
  });
  const output = await proc.output();
  const stdout = new TextDecoder().decode(output.stdout).trim();
  const stderr = new TextDecoder().decode(output.stderr).trim();
  if (stdout) logger.info(stdout);
  if (stderr && !output.success) logger.error(stderr);
  return { stdout, stderr, code: output.code };
}

const DOCKERFILE = `FROM node:22-alpine
WORKDIR /app
RUN npm init -y && npm install express@4 typescript@5 tsx@4 --save
COPY app.ts index.html ./
EXPOSE 3000
CMD ["npx", "tsx", "app.ts"]
`;

const INDEX_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>Hello, Swamp!</title>
  <style>
    body {
      font-family: sans-serif;
      text-align: center;
      margin: 2em;
      background: #1a1a2e;
      color: #e0e0e0;
    }
    img {
      max-width: 800px;
      max-height: 600px;
      border-radius: 8px;
      margin-top: 1em;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
    }
    a { color: #7ec8e3; }
  </style>
</head>
<body>
  <h1>Hello, Swamp!</h1>
  <p>Random image from <a href="https://en.wikipedia.org">Wikipedia</a>:</p>
  {{IMAGE_BLOCK}}
  <p style="margin-top: 1em"><a href="/">Refresh for another</a></p>
</body>
</html>
`;

const APP_TS = `import express from "express";
import { readFileSync } from "fs";

const app = express();
const template = readFileSync("index.html", "utf-8");

async function getRandomWikiImage() {
  const ua = { headers: { "Api-User-Agent": "SwampExpressHello/1.0" } };
  const res = await fetch(
    "https://en.wikipedia.org/w/api.php?action=query&generator=random" +
    "&grnnamespace=6&grnlimit=10&prop=imageinfo|fileusage" +
    "&iiprop=url|mime&iiurlwidth=800&fulimit=1&format=json",
    ua,
  );
  const data = await res.json();
  if (!data.query || !data.query.pages) {
    return { imgUrl: "", articleUrl: "", articleTitle: "" };
  }
  const pages = Object.values(data.query.pages) as any[];
  const images = pages.filter(
    (p) =>
      p.imageinfo?.[0]?.mime?.startsWith("image/") &&
      p.fileusage?.length > 0,
  );
  if (images.length === 0) {
    return { imgUrl: "", articleUrl: "", articleTitle: "" };
  }
  const pick = images[Math.floor(Math.random() * images.length)];
  const imgUrl = pick.imageinfo[0].thumburl || pick.imageinfo[0].url;
  const article = pick.fileusage[0];
  const articleUrl =
    "https://en.wikipedia.org/wiki/" +
    encodeURIComponent(article.title.replace(/ /g, "_"));
  return { imgUrl, articleUrl, articleTitle: article.title };
}

app.get("/", async (_req, res) => {
  const { imgUrl, articleUrl, articleTitle } = await getRandomWikiImage();
  let imageBlock: string;
  if (imgUrl) {
    imageBlock =
      '<a href="' + articleUrl + '" target="_blank">' +
      '<img src="' + imgUrl + '" />' +
      "</a>" +
      '<p>From: <a href="' + articleUrl + '" target="_blank">' +
      articleTitle +
      "</a></p>";
  } else {
    imageBlock = "<p>No image found, refresh to try again.</p>";
  }
  res.send(template.replace("{{IMAGE_BLOCK}}", imageBlock));
});

app.listen(3000, () => console.log("Listening on :3000"));
`;

/**
 * Swamp extension model for managing a demo Express.js Docker container
 * that serves random Wikipedia images.
 */
export const model = {
  type: "@bixu/express-hello",
  version: "2026.04.23.1",
  upgrade: [
    {
      fromVersion: "2026.03.19.2",
      toVersion: "2026.04.23.1",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  globalArguments: GlobalArgsSchema,
  resources: {
    state: {
      description: "Running container state",
      schema: StateSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
  },
  methods: {
    start: {
      description:
        "Build the Express Docker image and start the container. Access via browser at http://localhost:<port>",
      arguments: z.object({}),
      execute: async (_args: unknown, context: {
        globalArgs: { port: number; containerName: string };
        logger: { info: (msg: string) => void; error: (msg: string) => void };
        writeResource: (
          spec: string,
          instance: string,
          data: Record<string, unknown>,
        ) => Promise<unknown>;
        readResource: (
          spec: string,
          instance: string,
        ) => Promise<Record<string, unknown> | null>;
      }) => {
        const { port, containerName } = context.globalArgs;
        validateContainerName(containerName);
        validatePort(port);
        const imageName = "swamp-express-hello:latest";
        const logger = context.logger;

        // Purge cached swamp bundle and Docker image so code changes are
        // always picked up on next start.
        const bundlePath = ".swamp/bundles/express_hello.js";
        try {
          await Deno.remove(bundlePath);
          logger.info(`Removed stale bundle: ${bundlePath}`);
        } catch {
          // Bundle doesn't exist yet — nothing to clean
        }
        await runCmd(["docker", "rmi", "-f", imageName], logger);

        // Check if already running
        const existing = await context.readResource("state", "current");
        if (existing) {
          const check = await runCmd(
            ["docker", "inspect", "-f", "{{.State.Running}}", containerName],
            logger,
          );
          if (check.code === 0 && check.stdout === "true") {
            throw new Error(
              `Container ${containerName} is already running at http://localhost:${existing.port}`,
            );
          }
        }

        // Write build context to a temp dir
        const tmpDir = await Deno.makeTempDir({ prefix: "swamp-express-" });
        await Deno.writeTextFile(`${tmpDir}/Dockerfile`, DOCKERFILE);
        await Deno.writeTextFile(`${tmpDir}/app.ts`, APP_TS);
        await Deno.writeTextFile(`${tmpDir}/index.html`, INDEX_HTML);

        // Build image
        logger.info("Building Docker image...");
        const build = await runCmd(
          ["docker", "build", "--no-cache", "-t", imageName, tmpDir],
          logger,
        );
        if (build.code !== 0) {
          throw new Error(`Docker build failed: ${build.stderr}`);
        }

        // Remove stale container if exists
        await runCmd(["docker", "rm", "-f", containerName], logger);

        // Run container
        logger.info(`Starting container on port ${port}...`);
        const run = await runCmd([
          "docker",
          "run",
          "-d",
          "--name",
          containerName,
          "-p",
          `${port}:3000`,
          imageName,
        ], logger);
        if (run.code !== 0) {
          throw new Error(`Docker run failed: ${run.stderr}`);
        }

        const containerId = run.stdout;

        // Clean up temp dir
        await Deno.remove(tmpDir, { recursive: true });

        const url = `http://localhost:${port}`;
        logger.info(`Container started: ${url}`);

        const handle = await context.writeResource("state", "current", {
          containerId,
          containerName,
          imageName,
          port,
          url,
          status: "running",
          startedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    stop: {
      description: "Stop and remove the running container",
      arguments: z.object({}),
      execute: async (_args: unknown, context: {
        globalArgs: { containerName: string };
        logger: { info: (msg: string) => void; error: (msg: string) => void };
        readResource: (
          spec: string,
          instance: string,
        ) => Promise<Record<string, unknown> | null>;
      }) => {
        const { containerName } = context.globalArgs;
        validateContainerName(containerName);
        const logger = context.logger;

        logger.info(`Stopping container ${containerName}...`);
        const stop = await runCmd(
          ["docker", "rm", "-f", containerName],
          logger,
        );
        if (stop.code !== 0) {
          throw new Error(`Failed to stop container: ${stop.stderr}`);
        }
        logger.info("Container stopped and removed.");
        return { dataHandles: [] };
      },
    },

    status: {
      description: "Check if the container is running",
      arguments: z.object({}),
      execute: async (_args: unknown, context: {
        globalArgs: { containerName: string };
        logger: { info: (msg: string) => void; error: (msg: string) => void };
        writeResource: (
          spec: string,
          instance: string,
          data: Record<string, unknown>,
        ) => Promise<unknown>;
        readResource: (
          spec: string,
          instance: string,
        ) => Promise<Record<string, unknown> | null>;
      }) => {
        const { containerName } = context.globalArgs;
        validateContainerName(containerName);
        const logger = context.logger;

        const check = await runCmd(
          [
            "docker",
            "inspect",
            "-f",
            "{{.State.Running}}|{{.Id}}|{{.NetworkSettings.Ports}}",
            containerName,
          ],
          logger,
        );

        const existing = await context.readResource("state", "current");
        const port = existing?.port ?? 3000;

        if (check.code !== 0) {
          logger.info(`Container ${containerName} is not running.`);
          const handle = await context.writeResource("state", "current", {
            containerId: "",
            containerName,
            imageName: "swamp-express-hello:latest",
            port,
            url: `http://localhost:${port}`,
            status: "stopped",
            startedAt: existing?.startedAt ?? "",
          });
          return { dataHandles: [handle] };
        }

        const running = check.stdout.startsWith("true");
        logger.info(
          `Container ${containerName} is ${running ? "running" : "stopped"}.`,
        );

        const handle = await context.writeResource("state", "current", {
          containerId: existing?.containerId ?? "",
          containerName,
          imageName: "swamp-express-hello:latest",
          port,
          url: `http://localhost:${port}`,
          status: running ? "running" : "stopped",
          startedAt: existing?.startedAt ?? "",
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
