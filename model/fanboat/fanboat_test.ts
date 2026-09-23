import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.19";
import { fromFileUrl, join } from "jsr:@std/path@1.1.6";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20260921.36";
import { analyzeCode, instanceName, model, renderHtml } from "./fanboat.ts";
import {
  buildGraph,
  type CodeGraph,
  type CodeModule,
  packageId,
  type RepoScan,
  scanRepo,
  stringPropAt,
  vaultRefs,
} from "./fanboat_scan.ts";

Deno.test("packageId collapses specifiers to a versionless package", () => {
  assertEquals(packageId("npm:zod@4"), "npm:zod");
  assertEquals(packageId("npm:@octokit/rest@21.1.1"), "npm:@octokit/rest");
  assertEquals(packageId("jsr:@std/yaml@1/parse"), "jsr:@std/yaml");
  assertEquals(packageId("node:fs/promises"), "node:fs");
  assertEquals(
    packageId("https://deno.land/std@0.224.0/assert/mod.ts"),
    "deno.land/std",
  );
  assertEquals(packageId("./local.ts"), null);
});

Deno.test("vaultRefs finds quoted and bare vault names", () => {
  const text =
    `a: \${{ vault.get("default", "k") }}\nb: \${{ vault.get(prod-1, k) }}`;
  assertEquals(vaultRefs(text), ["default", "prod-1"]);
});

Deno.test("stringPropAt reads at a byte offset past multibyte text", () => {
  const src = `// café — naïve\nexport const model = { type: "@a/b" };`;
  const byteIndex =
    new TextEncoder().encode(src.slice(0, src.indexOf("type:"))).length;
  assertEquals(stringPropAt(src, byteIndex), "@a/b");
});

Deno.test("instanceName is flat and safe", () => {
  assertEquals(instanceName("/Users/x/My Repo/"), "my-repo");
  assertEquals(instanceName("/"), "repo");
});

Deno.test("renderHtml cannot close the data script early", () => {
  const graph = {
    repo: "r",
    nodes: [{ label: "</script><b>" }],
  } as unknown as CodeGraph;
  const html = renderHtml(
    "<title>__FANBOAT_TITLE__</title><script>__FANBOAT_DATA__</script>",
    graph,
  );
  assert(!html.includes("</script><b>"));
  assertStringIncludes(html, "\\u003c/script>");
});

Deno.test("buildGraph marks refs without definitions as unresolved", () => {
  const scan: RepoScan = {
    root: "/r",
    manifests: [],
    localSources: [],
    models: [{
      id: "1",
      name: "m",
      type: "@x/t",
      path: "/r/models/m.yaml",
      vaults: ["v"],
    }],
    workflows: [{
      id: "w1",
      name: "w",
      description: "",
      path: "/r/workflows/w.yaml",
      steps: [
        { job: "j", step: "s", model: "m", method: "go" },
        { job: "j", step: "s2", model: "ghost", method: "go" },
        { job: "j", step: "s3", model: "${{ inputs.m }}" },
      ],
    }],
    vaults: [],
    datastore: null,
    skipped: [],
  };
  const g = buildGraph(scan, []);
  const node = (id: string) => g.nodes.find((n) => n.id === id);
  assertEquals(node("type:@x/t")?.unresolved, true);
  assertEquals(node("vault:v")?.unresolved, true);
  assertEquals(node("model:ghost")?.unresolved, true);
  assertEquals(g.edges.filter((e) => e.kind === "calls").length, 2);
  assert(
    g.edges.some((e) =>
      e.source === "wf:w" && e.target === "model:m" && e.label === "go"
    ),
  );
});

Deno.test("buildGraph flags broken and suspicious nodes", () => {
  const model = (name: string, type: string, vaults: string[] = []) => ({
    id: name,
    name,
    type,
    path: `/r/models/${name}.yaml`,
    vaults,
  });
  const step = (model: string, method?: string) => ({
    job: "j",
    step: "s",
    model,
    method,
  });
  const scan: RepoScan = {
    root: "/r",
    manifests: [],
    localSources: [],
    models: [
      model("m1", "@x/t", ["gone-vault"]),
      model("dup", "@x/t"),
      { ...model("dup", "@x/t"), path: "/r/models/dup-2.yaml" },
      model("m3", "@swamp/base"),
    ],
    workflows: [{
      id: "w",
      name: "w",
      description: "",
      path: "/r/workflows/w.yaml",
      steps: [
        step("m1", "go"),
        step("m1", "nope"),
        step("ghost", "go"),
        step("m3", "baseMethod"),
        { job: "j", step: "s", workflow: "missing-wf" },
      ],
    }],
    vaults: [],
    datastore: null,
    skipped: [],
  };
  const mod = (
    path: string,
    types: CodeModule["types"] = [],
    error?: string,
  ) => ({
    path,
    doc: "",
    exports: [],
    imports: [],
    packages: [],
    types,
    error,
  });
  const code: CodeModule[] = [
    mod("/r/extensions/models/t.ts", [{
      type: "@x/t",
      methods: ["go"],
      extends: false,
    }]),
    mod("/r/extensions/models/u.ts", [{
      type: "@x/unused",
      methods: ["a"],
      extends: false,
    }]),
    mod("/r/extensions/models/ext.ts", [{
      type: "@swamp/base",
      methods: ["extra"],
      extends: true,
    }]),
    mod("/r/extensions/models/gone.ts", [], "Module not found"),
  ];
  const g = buildGraph(scan, code);
  const levels = (id: string) =>
    (g.nodes.find((n) => n.id === id)?.issues ?? []).map((i) => i.level);

  assertEquals(levels("model:m1"), ["broken"], "unknown method nope");
  assertEquals(levels("model:dup"), ["broken"], "duplicate name");
  assertEquals(levels("mod:extensions/models/gone.ts"), ["broken"]);
  assertEquals(levels("model:ghost"), ["suspicious"]);
  assertEquals(levels("wf:missing-wf"), ["suspicious"]);
  assertEquals(levels("vault:gone-vault"), ["suspicious"]);
  assertEquals(levels("type:@x/unused"), ["suspicious"]);
  assertEquals(levels("model:m3"), [], "extended types skip the method check");
  assertEquals(levels("type:@x/t"), []);
  assertEquals(levels("type:@swamp/base"), [], "pulled types are not flagged");
  assertEquals(g.stats.broken, 3);
  assertEquals(g.stats.suspicious, 4);
});

Deno.test("scanRepo skips unreadable files instead of failing", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(root, "models"));
    await Deno.writeTextFile(join(root, "models", "bad.yaml"), "name: [oops\n");
    await Deno.writeTextFile(join(root, "models", "no-type.yaml"), "name: x\n");
    await Deno.writeTextFile(
      join(root, "models", "ok.yaml"),
      "type: '@t/boat'\nname: ok\n",
    );
    await Deno.mkdir(join(root, "workflows"));
    await Deno.writeTextFile(join(root, "workflows", "bad.yaml"), ":\n  - [");
    await Deno.writeTextFile(join(root, "manifest.yaml"), "not: a manifest\n");
    const scan = await scanRepo(root);
    assertEquals(scan.models.map((m) => m.name), ["ok"]);
    assertEquals(scan.workflows, []);
    assertEquals(scan.manifests, []);
    assertEquals(scan.datastore, null);
    assertEquals(
      scan.skipped.map((p) => p.slice(root.length + 1)).sort(),
      ["models/bad.yaml", "workflows/bad.yaml"],
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("analyzeCode reports a missing import as a failed module", async () => {
  const root = await Deno.makeTempDir();
  try {
    const entry = join(root, "a.ts");
    await Deno.writeTextFile(
      entry,
      `import "./gone.ts";\nexport const a = 1;\n`,
    );
    const code = await analyzeCode([entry]);
    const gone = code.find((m) => m.path.endsWith("gone.ts"));
    assert(gone?.error, "missing file carries an error");
    assert(
      code.find((m) => m.path === entry)?.imports.some((i) =>
        i.endsWith("gone.ts")
      ),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

/** A tiny swamp repo: one extension, one model, one workflow, one datastore. */
async function boatRepo(): Promise<string> {
  const root = await Deno.makeTempDir();
  const ext = join(root, "extensions", "models", "boat");
  await Deno.mkdir(ext, { recursive: true });
  await Deno.writeTextFile(
    join(root, "extensions", "models", "manifest.yaml"),
    `manifestVersion: 1\nname: "@t/boat"\nversion: "1"\nmodels:\n  - boat/boat.ts\n`,
  );
  await Deno.writeTextFile(join(ext, "helper.ts"), `export const x = 1;\n`);
  await Deno.writeTextFile(
    join(ext, "boat.ts"),
    `/**\n * @module\n * Boats — fast ones.\n */\nimport { z } from "npm:zod@4";\nimport { x } from "./helper.ts";\n` +
      `export const model = {\n  type: "@t/boat",\n  version: "1",\n  methods: { skim: { arguments: z.object({}), execute: () => x } },\n};\n`,
  );
  await Deno.mkdir(join(root, "models", "@t", "boat"), { recursive: true });
  await Deno.writeTextFile(
    join(root, "models", "@t", "boat", "b1.yaml"),
    `type: "@t/boat"\nid: b-1\nname: b1\nglobalArguments:\n  key: \${{ vault.get(main, k) }}\n`,
  );
  await Deno.mkdir(join(root, "workflows"));
  await Deno.writeTextFile(
    join(root, "workflows", "w.yaml"),
    `id: w-1\nname: tour\njobs:\n  - name: j\n    steps:\n      - name: s\n        task:\n          type: model_method\n          modelIdOrName: b-1\n          methodName: skim\n`,
  );
  await Deno.writeTextFile(
    join(root, ".swamp.yaml"),
    `datastore:\n  type: "@swamp/s3-datastore"\n  namespace: ns\n`,
  );
  return root;
}

Deno.test("map chain: workflow → model → type → module → package", async () => {
  const root = await boatRepo();
  try {
    const scan = await scanRepo(root);
    const code = await analyzeCode([
      ...scan.manifests.flatMap((m) => m.entries.map((e) => e.path)),
      ...scan.localSources,
    ]);
    const g = buildGraph(scan, code);
    const has = (s: string, t: string, kind: string) =>
      g.edges.some((e) => e.source === s && e.target === t && e.kind === kind);

    assertEquals(g.datastore, "@swamp/s3-datastore (ns)");
    assert(has("wf:tour", "model:b1", "calls"), "workflow → model by id");
    assert(has("model:b1", "type:@t/boat", "instanceOf"));
    assert(has("model:b1", "vault:main", "usesVault"));
    const mod = "mod:extensions/models/boat/boat.ts";
    assert(has("type:@t/boat", mod, "definedIn"));
    assert(has(mod, "mod:extensions/models/boat/helper.ts", "imports"));
    assert(has(mod, "pkg:npm:zod", "dependsOn"));
    const type = g.nodes.find((n) => n.id === "type:@t/boat")!;
    assertEquals(type.methods, ["skim"]);
    assertEquals(type.unresolved, false);
    assertEquals(g.nodes.find((n) => n.id === mod)?.group, "@t/boat");
    assertEquals(g.nodes.find((n) => n.id === mod)?.doc, "Boats — fast ones.");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("map writes the graph and the page, named after the repo", async () => {
  const root = await boatRepo();
  try {
    const { context, getWrittenResources, getWrittenFiles, getLogsByLevel } =
      createModelTestContext({ repoDir: root, methodName: "map" });
    const ctx = {
      ...context,
      extensionFile: (p: string) => fromFileUrl(new URL(p, import.meta.url)),
    };
    await model.methods.map.execute({}, ctx);
    const name = instanceName(root);
    const [graph] = getWrittenResources();
    assertEquals(graph.name, `${name}-graph`);
    assertEquals((graph.data as unknown as CodeGraph).stats.workflows, 1);
    const [page] = getWrittenFiles();
    assertEquals(page.name, `${name}-page`);
    const html = new TextDecoder().decode(page.content as Uint8Array);
    assertStringIncludes(html, '"repo":');
    assert(!html.includes("__FANBOAT_DATA__"));
    assertEquals(getLogsByLevel("warning").length, 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("map refuses a path that is not a directory, before any write", async () => {
  const { context, getWrittenResources, getWrittenFiles } =
    createModelTestContext({ repoDir: "/", methodName: "map" });
  await assertRejects(
    () => model.methods.map.execute({ path: "/does/not/exist" }, context),
    Error,
    "not a directory",
  );
  assertEquals(getWrittenResources().length, 0);
  assertEquals(getWrittenFiles().length, 0);
});
