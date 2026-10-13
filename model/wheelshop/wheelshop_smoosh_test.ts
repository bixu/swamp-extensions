import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  calverToday,
  canonicalJson,
  isEntryPoint,
  licenseNotice,
  mergeManifest,
  resolveRelative,
  retarget,
  rewireImports,
  smooshHeader,
} from "./wheelshop_smoosh.ts";
import { model } from "./wheelshop.ts";
import type { PriorArtSource } from "./wheelshop_helpers.ts";

const SOURCE: PriorArtSource = {
  extension: "@sntxrr/acl-drift",
  version: "2026.07.24.2",
  repository: "https://github.com/sntxrr/swamp-tailscale",
  license: "MIT",
  files: [],
};

// --- pure helpers ---

Deno.test("smooshHeader carries the attribute check's Derived from line", () => {
  assertEquals(
    smooshHeader(SOURCE, "models/drift.ts"),
    "// Derived from @sntxrr/acl-drift@2026.07.24.2 (models/drift.ts), MIT.",
  );
});

Deno.test("retarget swaps quoted and backticked types only", () => {
  const { text, changed } = retarget(
    'type: "@john/acl",\n// see `@john/acl` and @john/aclx',
    { "@john/acl": "@swamp/tailscale/policy-file" },
  );
  assertEquals(changed, true);
  assertEquals(
    text,
    'type: "@swamp/tailscale/policy-file",\n// see `@swamp/tailscale/policy-file` and @john/aclx',
  );
  assertEquals(retarget("x", { "@a/b": "@c/d" }).changed, false);
});

Deno.test("resolveRelative handles ./ and ../", () => {
  assertEquals(resolveRelative("models/a.ts", "./b.ts"), "models/b.ts");
  assertEquals(
    resolveRelative("models/x/a.ts", "../_lib/c.ts"),
    "models/_lib/c.ts",
  );
});

Deno.test("rewireImports maps carried files and reports the rest", () => {
  const { text, unmapped } = rewireImports(
    'import { a } from "./drift.ts";\nimport { b } from "./_lib/api.ts";\nimport { z } from "npm:zod@4";\nconst m = await import("./drift.ts");',
    "models/propose.ts",
    { "models/drift.ts": "policy_drift.ts" },
  );
  assertEquals(
    text,
    'import { a } from "./policy_drift.ts";\nimport { b } from "./_lib/api.ts";\nimport { z } from "npm:zod@4";\nconst m = await import("./policy_drift.ts");',
  );
  assertEquals(unmapped, ["./_lib/api.ts"]);
});

Deno.test("isEntryPoint spots models and extensions", () => {
  assertEquals(isEntryPoint("export const model = {"), true);
  assertEquals(isEntryPoint("export const extension = {"), true);
  assertEquals(isEntryPoint("export function parse() {}"), false);
});

Deno.test("licenseNotice names the source and includes its license", () => {
  const notice = licenseNotice(SOURCE, "MIT License\n");
  assertStringIncludes(notice, "@sntxrr/acl-drift");
  assertStringIncludes(notice, "(https://github.com/sntxrr/swamp-tailscale)");
  assertStringIncludes(notice, "MIT License");
});

Deno.test("mergeManifest keeps existing fields and unions lists", () => {
  assertEquals(
    mergeManifest(
      {
        name: "@me/x",
        version: "2026.01.01.3",
        labels: ["a"],
        models: ["m.ts"],
      },
      {
        name: "@me/ignored",
        version: "2026.10.13.1",
        description: "d",
        base: "@swamp/tailscale",
        models: ["m.ts", "n.ts"],
        additionalFiles: ["LICENSE.txt"],
      },
    ),
    {
      manifestVersion: 1,
      name: "@me/x",
      version: "2026.01.01.3",
      description: "d",
      paths: { base: "manifest" },
      labels: ["a"],
      models: ["m.ts", "n.ts"],
      additionalFiles: ["LICENSE.txt"],
      dependencies: ["@swamp/tailscale"],
    },
  );
});

Deno.test("canonicalJson ignores key order only", () => {
  assertEquals(
    canonicalJson({ a: 1, b: [2, 1] }),
    canonicalJson({ b: [2, 1], a: 1 }),
  );
  assertEquals(canonicalJson([1, 2]) === canonicalJson([2, 1]), false);
});

Deno.test("calverToday is the first build of the UTC day", () => {
  assertEquals(calverToday(new Date("2026-10-13T23:00:00Z")), "2026.10.13.1");
});

// --- smoosh method ---

const DRIFT = `import { z } from "npm:zod@4";
export function parse(s: string) { return JSON.parse(s); }
export const extension = {
  type: "@john/tailscale-acl",
  methods: [{ drift: { execute: async (_a: unknown, c: { readResource: (n: string) => unknown }) => c.readResource("current") } }],
};
`;
const PROPOSE = `import { parse } from "./drift.ts";
export const extension = { type: "@john/tailscale-acl", methods: [] };
`;

async function fakeRepo() {
  const repoDir = await Deno.makeTempDir();
  const root = `${repoDir}/.swamp/pulled-extensions/@sntxrr/acl-drift`;
  await Deno.mkdir(`${root}/models`, { recursive: true });
  await Deno.mkdir(`${root}/files`, { recursive: true });
  await Deno.writeTextFile(`${root}/manifest.yaml`, "version: 2026.07.24.2\n");
  await Deno.writeTextFile(`${root}/models/drift.ts`, DRIFT);
  await Deno.writeTextFile(`${root}/models/propose.ts`, PROPOSE);
  await Deno.writeTextFile(
    `${root}/files/LICENSE.md`,
    "MIT License\n\nCopyright (c) 2026 sntxrr\n\nPermission is hereby granted, free of charge,",
  );
  return repoDir;
}

function smooshArgs(outDir: string) {
  return {
    outDir,
    name: "@me/tailscale-community",
    description: "Community add-ons for @swamp/tailscale",
    base: "@swamp/tailscale",
    sources: [{
      extension: "@sntxrr/acl-drift",
      version: "2026.07.24.2",
      repository: "https://github.com/sntxrr/swamp-tailscale",
      license: null,
      files: [
        { from: "models/drift.ts", to: "policy_drift.ts" },
        { from: "models/propose.ts", to: "policy_propose.ts" },
      ],
      retarget: { "@john/tailscale-acl": "@swamp/tailscale/policy-file" },
    }],
  };
}

async function runSmoosh(repoDir: string, outDir: string) {
  const written: Record<string, unknown>[] = [];
  await model.methods.smoosh.execute(smooshArgs(outDir), {
    repoDir,
    logger: { info: () => {} },
    writeResource: (spec: string, name: string, data: unknown) => {
      if (spec === "smoosh") written.push(data as Record<string, unknown>);
      return Promise.resolve({ name });
    },
  });
  return written[0];
}

Deno.test("smoosh builds a derived extension and flags what needs a human", async () => {
  const repoDir = await fakeRepo();
  const outDir = `${repoDir}/model/tailscale-community`;

  const first = await runSmoosh(repoDir, outDir);
  assertEquals(first.action, "fix");
  assertEquals(first.blockers, [
    "own-license-missing (put your license at the top of LICENSE.txt)",
    "needs-adaptation:policy_drift.ts (reads stored data of a retargeted type; check the new type's schema)",
    "readme-missing",
  ]);

  const drift = await Deno.readTextFile(`${outDir}/policy_drift.ts`);
  assertStringIncludes(
    drift,
    "// Derived from @sntxrr/acl-drift@2026.07.24.2 (models/drift.ts), MIT.",
  );
  assertStringIncludes(drift, 'type: "@swamp/tailscale/policy-file"');
  const propose = await Deno.readTextFile(`${outDir}/policy_propose.ts`);
  assertStringIncludes(propose, 'from "./policy_drift.ts"');
  assertStringIncludes(
    await Deno.readTextFile(`${outDir}/LICENSE.txt`),
    "Copyright (c) 2026 sntxrr",
  );
  const manifest = await Deno.readTextFile(`${outDir}/manifest.yaml`);
  assertStringIncludes(manifest, "- policy_drift.ts");
  assertStringIncludes(manifest, "- '@swamp/tailscale'");
  assertStringIncludes(
    await Deno.readTextFile(`${outDir}/prior-art.yaml`),
    "license: MIT",
  );

  // The agent adapts the drift code, adds its own license and a README.
  await Deno.writeTextFile(`${outDir}/policy_drift.ts`, drift + "// adapted\n");
  const license = await Deno.readTextFile(`${outDir}/LICENSE.txt`);
  await Deno.writeTextFile(
    `${outDir}/LICENSE.txt`,
    "MIT License (c) me\n" + license,
  );
  await Deno.writeTextFile(`${outDir}/README.md`, "# x\n");

  // A hand comment in the manifest survives a no-op re-run.
  const manifestPath = `${outDir}/manifest.yaml`;
  await Deno.writeTextFile(
    manifestPath,
    "# hand-written\n" + (await Deno.readTextFile(manifestPath)).replace(
      "additionalFiles:\n",
      "additionalFiles:\n  - README.md\n",
    ),
  );

  const second = await runSmoosh(repoDir, outDir);
  assertEquals(second.blockers, []);
  assertEquals(second.action, "ok");
  assertEquals(second.kept, ["policy_drift.ts"]);
  assertEquals(second.written, ["prior-art.yaml"]);
  assertStringIncludes(
    await Deno.readTextFile(manifestPath),
    "# hand-written",
  );
  assertStringIncludes(
    await Deno.readTextFile(`${outDir}/policy_drift.ts`),
    "// adapted",
  );
  assertEquals(
    (await Deno.readTextFile(`${outDir}/LICENSE.txt`)).split(
      "@sntxrr/acl-drift",
    ).length,
    2,
  );
  await Deno.remove(repoDir, { recursive: true });
});

Deno.test("smoosh blocks a source that is not pulled at that version", async () => {
  const repoDir = await fakeRepo();
  const args = smooshArgs(`${repoDir}/out`);
  args.sources[0].version = "2026.08.01.1";
  const written: Record<string, unknown>[] = [];
  await model.methods.smoosh.execute(args, {
    repoDir,
    logger: { info: () => {} },
    writeResource: (spec: string, name: string, data: unknown) => {
      if (spec === "smoosh") written.push(data as Record<string, unknown>);
      return Promise.resolve({ name });
    },
  });
  assertStringIncludes(
    (written[0].blockers as string[]).join("\n"),
    "not-pulled:@sntxrr/acl-drift@2026.08.01.1",
  );
  await Deno.remove(repoDir, { recursive: true });
});
