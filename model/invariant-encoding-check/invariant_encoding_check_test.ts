// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1";
import {
  allTsFiles,
  changedTsFiles,
  formatFindingsMessage,
  GlobalArgsSchema,
  model,
  resolveScanFiles,
  scanSource,
} from "./invariant_encoding_check.ts";

// --- scanSource: z.any() ---

Deno.test("scanSource: flags bare z.any()", () => {
  const findings = scanSource("f.ts", "const S = z.any();");
  assertEquals(findings.length, 1);
  assertEquals(findings[0].rule, "z-any");
  assertEquals(findings[0].line, 1);
});

Deno.test("scanSource: z.any inside a string literal on a describe still trips but escape hatch silences it", () => {
  const src = [
    "const S = z.string().describe(`z.any is bad`); // invariant-check: doc text",
  ].join("\n");
  const findings = scanSource("f.ts", src);
  assertEquals(findings.length, 0);
});

// --- scanSource: z.unknown() ---

Deno.test("scanSource: flags bare z.unknown()", () => {
  const findings = scanSource("f.ts", "const S = z.unknown();");
  assertEquals(findings.length, 1);
  assertEquals(findings[0].rule, "z-unknown");
});

Deno.test("scanSource: allows z.record(z.string(), z.unknown()) on one line", () => {
  const src = "const S = z.record(z.string(), z.unknown());";
  const findings = scanSource("f.ts", src);
  assertEquals(findings.length, 0);
});

Deno.test("scanSource: multi-line z.record wrap still trips z-unknown (documented gap)", () => {
  const src = [
    "const S = z.record(",
    "  z.string(),",
    "  z.unknown(),",
    ");",
  ].join("\n");
  const findings = scanSource("f.ts", src);
  assertEquals(findings.length, 1);
  assertEquals(findings[0].rule, "z-unknown");
});

// --- scanSource: as any / as unknown as ---

Deno.test("scanSource: flags as any cast", () => {
  const findings = scanSource("f.ts", "const x = foo as any;");
  assertEquals(findings.length, 1);
  assertEquals(findings[0].rule, "as-any");
});

Deno.test("scanSource: flags as unknown as double cast", () => {
  const findings = scanSource("f.ts", "const x = foo as unknown as Bar;");
  assertEquals(findings.length, 1);
  assertEquals(findings[0].rule, "as-unknown-as");
});

// --- scanSource: semantic-id rule ---

Deno.test("scanSource: flags bare z.string() on a digest field", () => {
  const findings = scanSource("f.ts", "  digest: z.string(),");
  assertEquals(findings.length, 1);
  assertEquals(findings[0].rule, "bare-string-on-semantic-id");
});

Deno.test("scanSource: allows z.string().regex() on a digest field", () => {
  const findings = scanSource(
    "f.ts",
    "  digest: z.string().regex(/^sha256:[0-9a-f]+$/),",
  );
  assertEquals(findings.length, 0);
});

Deno.test("scanSource: allows .refine on a version field", () => {
  const findings = scanSource(
    "f.ts",
    "  version: z.string().refine((v) => v.length > 0),",
  );
  assertEquals(findings.length, 0);
});

Deno.test("scanSource: allows .brand on a platform field", () => {
  const findings = scanSource(
    "f.ts",
    "  platform: z.string().brand('Platform'),",
  );
  assertEquals(findings.length, 0);
});

Deno.test("scanSource: .brand<T>() with a generic slips past encoded-chain (documented gap: chain regex wants .brand( literal)", () => {
  // The encoded-chain regex is `\.(regex|refine|brand|pipe)\s*\(` — literal
  // paren, no room for a `<T>` before it. `.brand<Platform>()` is a common
  // zod idiom but does not match today. Callers who want to be safe write
  // `.brand("Platform")` or reach for `.regex(...)`/`.refine(...)`.
  const findings = scanSource(
    "f.ts",
    "  platform: z.string().brand<'Platform'>(),",
  );
  assertEquals(findings.length, 1);
  assertEquals(findings[0].rule, "bare-string-on-semantic-id");
});

Deno.test("scanSource: allows .pipe on a ref field", () => {
  const findings = scanSource(
    "f.ts",
    "  ref: z.string().pipe(z.string().min(1)),",
  );
  assertEquals(findings.length, 0);
});

Deno.test("scanSource: longer semantic-id (sourceDigest) is matched, not the mid-word digest", () => {
  const findings = scanSource("f.ts", "  sourceDigest: z.string(),");
  assertEquals(findings.length, 1);
  assertEquals(findings[0].rule, "bare-string-on-semantic-id");
});

Deno.test("scanSource: field name that is not a semantic id passes bare z.string()", () => {
  const findings = scanSource("f.ts", "  name: z.string(),");
  assertEquals(findings.length, 0);
});

Deno.test("scanSource: compound camelCase like manifestDigest slips through (documented gap)", () => {
  const findings = scanSource("f.ts", "  manifestDigest: z.string(),");
  assertEquals(findings.length, 0);
});

// --- scanSource: escape hatch ---

Deno.test("scanSource: escape hatch with reason silences one line", () => {
  const findings = scanSource(
    "f.ts",
    "const S = z.any(); // invariant-check: legacy shape we cannot type",
  );
  assertEquals(findings.length, 0);
});

Deno.test("scanSource: escape hatch with empty reason itself becomes a finding", () => {
  const findings = scanSource("f.ts", "const S = z.any(); // invariant-check:");
  assertEquals(findings.length, 1);
  assertEquals(findings[0].rule, "empty-exception-reason");
});

// --- scanSource: comment-line and stripping guards ---

Deno.test("scanSource: pure line comments are skipped entirely", () => {
  const findings = scanSource("f.ts", "// z.any() is bad");
  assertEquals(findings.length, 0);
});

Deno.test("scanSource: leading star comment (jsdoc body) is skipped", () => {
  const findings = scanSource("f.ts", " * mentions z.any() in a doc block");
  assertEquals(findings.length, 0);
});

Deno.test("scanSource: url inside a string literal (no whitespace before //) survives", () => {
  // "https://example.com" — the // has no preceding whitespace, so it
  // is NOT stripped; the semantic-id rule below still sees the full line.
  const findings = scanSource(
    "f.ts",
    "  ref: z.string().regex(/^https:\\/\\/.*$/),",
  );
  assertEquals(findings.length, 0);
});

Deno.test("scanSource: trailing `// note` comment is stripped so an unrelated `as any` in the comment does not trip", () => {
  const findings = scanSource(
    "f.ts",
    "const x = 1; // do not use as any anywhere",
  );
  assertEquals(findings.length, 0);
});

// --- scanSource: multiple rules on one line ---

Deno.test("scanSource: one line can produce multiple findings", () => {
  const findings = scanSource(
    "f.ts",
    "const x = (y as any) as unknown as Z;",
  );
  const rules = findings.map((f) => f.rule).sort();
  assertEquals(rules, ["as-any", "as-unknown-as"]);
});

// --- formatFindingsMessage ---

Deno.test("formatFindingsMessage: shows count, file:line, rule, text", () => {
  const msg = formatFindingsMessage([
    {
      file: "extensions/models/foo.ts",
      line: 42,
      rule: "z-any",
      text: "const x = z.any();",
    },
  ]);
  assertStringIncludes(msg, "1 unencoded invariant(s) found");
  assertStringIncludes(msg, "extensions/models/foo.ts:42");
  assertStringIncludes(msg, "[z-any]");
  assertStringIncludes(msg, "z.any()");
  assertStringIncludes(msg, ".regex(...)");
});

// --- GlobalArgsSchema ---

Deno.test("GlobalArgsSchema: default root is extensions/models", () => {
  assertEquals(GlobalArgsSchema.parse({}).root, "extensions/models");
});

Deno.test("GlobalArgsSchema: caller can override root", () => {
  assertEquals(
    GlobalArgsSchema.parse({ root: "src/models" }).root,
    "src/models",
  );
});

// --- model shape ---

Deno.test("model: has correct type identifier", () => {
  assertEquals(model.type, "@bixu/invariant-encoding-check");
});

Deno.test("model: has short-CalVer version", () => {
  assert(/^\d{4}\.\d{2}\.\d{2}\.\d+$/.test(model.version));
});

Deno.test("model: declares report resource with infinite lifetime", () => {
  assertEquals(model.resources.report.lifetime, "infinite");
  assertEquals(model.resources.report.garbageCollection, 20);
});

Deno.test("model: declares check method", () => {
  assertEquals("check" in model.methods, true);
});

// --- resolveScanFiles: paths mode ---

Deno.test("resolveScanFiles: paths mode returns exactly those files", async () => {
  const r = await resolveScanFiles(
    { all: false, paths: ["a.ts", "b.ts"] },
    "extensions/models",
  );
  assertEquals(r.mode, "paths");
  assertEquals(r.files, ["a.ts", "b.ts"]);
});

// --- resolveScanFiles: all mode over a temp tree ---

Deno.test("resolveScanFiles: all mode walks the root and skips _test.ts", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/nested`, { recursive: true });
    await Deno.writeTextFile(`${dir}/a.ts`, "");
    await Deno.writeTextFile(`${dir}/nested/b.ts`, "");
    await Deno.writeTextFile(`${dir}/nested/b_test.ts`, "");
    const r = await resolveScanFiles({ all: true }, dir);
    assertEquals(r.mode, "all");
    const paths = r.files.map((f) => f.replace(`${dir}/`, "")).sort();
    assertEquals(paths, ["a.ts", "nested/b.ts"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- resolveScanFiles: none mode ---

Deno.test("resolveScanFiles: none mode returns empty when no signal at all", async () => {
  const prior = Deno.env.get("GITHUB_BASE_REF");
  Deno.env.delete("GITHUB_BASE_REF");
  try {
    const r = await resolveScanFiles({ all: false }, "extensions/models");
    assertEquals(r.mode, "none");
    assertEquals(r.files, []);
  } finally {
    if (prior !== undefined) Deno.env.set("GITHUB_BASE_REF", prior);
  }
});

// --- allTsFiles direct ---

Deno.test("allTsFiles: root with no ts files returns empty list", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const files = await allTsFiles(dir);
    assertEquals(files, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- changedTsFiles: real git subprocess in a temp repo ---

Deno.test("changedTsFiles: returns ts files changed between two commits, excludes _test.ts", () => {
  const dir = Deno.makeTempDirSync();
  try {
    const runOk = (args: string[]) => {
      const out = new Deno.Command("git", { args, cwd: dir }).outputSync();
      assert(out.success, `git ${args.join(" ")} failed`);
    };
    runOk(["init", "-q", "-b", "main"]);
    runOk(["config", "user.email", "t@t"]);
    runOk(["config", "user.name", "t"]);
    Deno.mkdirSync(`${dir}/pkg`);
    Deno.writeTextFileSync(`${dir}/pkg/a.ts`, "// v1\n");
    runOk(["add", "."]);
    runOk(["commit", "-q", "-m", "init"]);
    const base = new TextDecoder().decode(
      new Deno.Command("git", { args: ["rev-parse", "HEAD"], cwd: dir })
        .outputSync().stdout,
    ).trim();
    Deno.writeTextFileSync(`${dir}/pkg/a.ts`, "// v2\n");
    Deno.writeTextFileSync(`${dir}/pkg/b.ts`, "// new\n");
    Deno.writeTextFileSync(`${dir}/pkg/b_test.ts`, "// new test\n");
    Deno.writeTextFileSync(`${dir}/pkg/c.md`, "not ts\n");
    runOk(["add", "."]);
    runOk(["commit", "-q", "-m", "change"]);

    const priorCwd = Deno.cwd();
    Deno.chdir(dir);
    try {
      const files = changedTsFiles(base, "pkg").sort();
      assertEquals(files, ["pkg/a.ts", "pkg/b.ts"]);
    } finally {
      Deno.chdir(priorCwd);
    }
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("changedTsFiles: throws on git failure (bad ref)", () => {
  assertThrows(
    () => changedTsFiles("no-such-ref-nowhere", "extensions/models"),
    Error,
    "git diff",
  );
});

// --- resolveScanFiles: baseRef mode uses git subprocess ---

Deno.test("resolveScanFiles: baseRef arg wins over env, and origin/ prefix is added for a bare ref name", async () => {
  const dir = Deno.makeTempDirSync();
  try {
    const runOk = (args: string[]) => {
      const out = new Deno.Command("git", { args, cwd: dir }).outputSync();
      assert(out.success);
    };
    runOk(["init", "-q", "-b", "main"]);
    runOk(["config", "user.email", "t@t"]);
    runOk(["config", "user.name", "t"]);
    Deno.mkdirSync(`${dir}/pkg`);
    Deno.writeTextFileSync(`${dir}/pkg/a.ts`, "// v1\n");
    runOk(["add", "."]);
    runOk(["commit", "-q", "-m", "init"]);
    const base = new TextDecoder().decode(
      new Deno.Command("git", { args: ["rev-parse", "HEAD"], cwd: dir })
        .outputSync().stdout,
    ).trim();
    Deno.writeTextFileSync(`${dir}/pkg/a.ts`, "// v2\n");
    runOk(["add", "."]);
    runOk(["commit", "-q", "-m", "change"]);

    const priorCwd = Deno.cwd();
    Deno.chdir(dir);
    try {
      // Passing a SHA (contains no "/" and no "..") means the resolver
      // adds origin/, which will not exist in the temp repo. Use the
      // sha with a range operator to bypass the origin/ prefix.
      const r = await resolveScanFiles(
        { all: false, baseRef: `${base}..HEAD` },
        "pkg",
      );
      assertEquals(r.mode, "baseRef");
      assertEquals(r.files, ["pkg/a.ts"]);
    } finally {
      Deno.chdir(priorCwd);
    }
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("resolveScanFiles: a bare ref name is prefixed with origin/ (so a git repo with no remote surfaces the error)", async () => {
  const dir = Deno.makeTempDirSync();
  try {
    const runOk = (args: string[]) => {
      const out = new Deno.Command("git", { args, cwd: dir }).outputSync();
      assert(out.success);
    };
    runOk(["init", "-q", "-b", "main"]);
    runOk(["config", "user.email", "t@t"]);
    runOk(["config", "user.name", "t"]);
    Deno.writeTextFileSync(`${dir}/a.ts`, "// v1\n");
    runOk(["add", "."]);
    runOk(["commit", "-q", "-m", "init"]);
    const priorCwd = Deno.cwd();
    Deno.chdir(dir);
    try {
      await assertRejects(
        () => resolveScanFiles({ all: false, baseRef: "main" }, "."),
        Error,
        "origin/main",
      );
    } finally {
      Deno.chdir(priorCwd);
    }
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("resolveScanFiles: baseRef containing '/' is passed through without adding origin/", async () => {
  const dir = Deno.makeTempDirSync();
  try {
    const runOk = (args: string[]) => {
      const out = new Deno.Command("git", { args, cwd: dir }).outputSync();
      assert(out.success);
    };
    runOk(["init", "-q", "-b", "main"]);
    runOk(["config", "user.email", "t@t"]);
    runOk(["config", "user.name", "t"]);
    Deno.mkdirSync(`${dir}/pkg`);
    Deno.writeTextFileSync(`${dir}/pkg/a.ts`, "// v1\n");
    runOk(["add", "."]);
    runOk(["commit", "-q", "-m", "init"]);
    runOk(["branch", "feature/x"]);
    Deno.writeTextFileSync(`${dir}/pkg/a.ts`, "// v2\n");
    runOk(["add", "."]);
    runOk(["commit", "-q", "-m", "change"]);

    const priorCwd = Deno.cwd();
    Deno.chdir(dir);
    try {
      const r = await resolveScanFiles(
        { all: false, baseRef: "feature/x" },
        "pkg",
      );
      assertEquals(r.mode, "baseRef");
      assertEquals(r.files, ["pkg/a.ts"]);
    } finally {
      Deno.chdir(priorCwd);
    }
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("resolveScanFiles: GITHUB_BASE_REF env is used when no baseRef arg", async () => {
  const dir = Deno.makeTempDirSync();
  const prior = Deno.env.get("GITHUB_BASE_REF");
  try {
    const runOk = (args: string[]) => {
      const out = new Deno.Command("git", { args, cwd: dir }).outputSync();
      assert(out.success);
    };
    runOk(["init", "-q", "-b", "main"]);
    runOk(["config", "user.email", "t@t"]);
    runOk(["config", "user.name", "t"]);
    Deno.mkdirSync(`${dir}/pkg`);
    Deno.writeTextFileSync(`${dir}/pkg/a.ts`, "// v1\n");
    runOk(["add", "."]);
    runOk(["commit", "-q", "-m", "init"]);
    const base = new TextDecoder().decode(
      new Deno.Command("git", { args: ["rev-parse", "HEAD"], cwd: dir })
        .outputSync().stdout,
    ).trim();
    Deno.writeTextFileSync(`${dir}/pkg/a.ts`, "// v2\n");
    runOk(["add", "."]);
    runOk(["commit", "-q", "-m", "change"]);

    const priorCwd = Deno.cwd();
    Deno.chdir(dir);
    Deno.env.set("GITHUB_BASE_REF", `${base}..HEAD`);
    try {
      const r = await resolveScanFiles({ all: false }, "pkg");
      assertEquals(r.mode, "baseRef");
      assertEquals(r.files, ["pkg/a.ts"]);
    } finally {
      Deno.chdir(priorCwd);
      if (prior === undefined) Deno.env.delete("GITHUB_BASE_REF");
      else Deno.env.set("GITHUB_BASE_REF", prior);
    }
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

// --- check method: fake context wiring ---

type Handle = { resource: string; id: string; data: unknown };
function fakeContext(globalArgs: { root: string }) {
  const written: Handle[] = [];
  const logs: string[] = [];
  return {
    globalArgs,
    written,
    logs,
    writeResource: (resource: string, id: string, data: unknown) => {
      const handle = { resource, id, data };
      written.push(handle);
      return Promise.resolve(handle);
    },
    logger: {
      info: (msg: string) => logs.push(`info:${msg}`),
      error: (msg: string) => logs.push(`error:${msg}`),
    },
  };
}

Deno.test("check: no files in scope writes empty report and does not throw", async () => {
  const ctx = fakeContext({ root: "extensions/models" });
  const prior = Deno.env.get("GITHUB_BASE_REF");
  Deno.env.delete("GITHUB_BASE_REF");
  try {
    const result = await model.methods.check.execute(
      { all: false },
      ctx,
    );
    assertEquals(ctx.written.length, 1);
    const data = ctx.written[0].data as {
      findings: unknown[];
      scanMode: string;
    };
    assertEquals(data.findings, []);
    assertEquals(data.scanMode, "none");
    assertEquals(result.dataHandles.length, 1);
  } finally {
    if (prior !== undefined) Deno.env.set("GITHUB_BASE_REF", prior);
  }
});

Deno.test("check: clean file writes ok report, no throw", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const cleanFile = `${dir}/clean.ts`;
    await Deno.writeTextFile(
      cleanFile,
      "export const S = { name: z.string() };\n",
    );
    const ctx = fakeContext({ root: dir });
    await model.methods.check.execute({ paths: [cleanFile] }, ctx);
    const data = ctx.written[0].data as {
      findings: unknown[];
      summary: string;
    };
    assertEquals(data.findings, []);
    assertStringIncludes(data.summary, "pass invariant-encoding");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("check: dirty file throws with a formatted summary and still writes the report", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const dirty = `${dir}/dirty.ts`;
    await Deno.writeTextFile(dirty, "const S = z.any();\n");
    const ctx = fakeContext({ root: dir });
    await assertRejects(
      () => model.methods.check.execute({ paths: [dirty] }, ctx),
      Error,
      "unencoded invariant",
    );
    assertEquals(ctx.written.length, 1);
    const data = ctx.written[0].data as { findings: unknown[] };
    assertEquals(data.findings.length, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("check: missing file is silently skipped (NotFound branch)", async () => {
  const ctx = fakeContext({ root: "extensions/models" });
  await model.methods.check.execute(
    { paths: ["/does/not/exist/anywhere.ts"] },
    ctx,
  );
  const data = ctx.written[0].data as { findings: unknown[]; summary: string };
  assertEquals(data.findings, []);
  assertStringIncludes(data.summary, "pass invariant-encoding");
});

Deno.test("check: unreadable file (permission) surfaces as a thrown error", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const secret = `${dir}/secret.ts`;
    await Deno.writeTextFile(secret, "const S = z.any();\n");
    await Deno.chmod(secret, 0o000);
    const ctx = fakeContext({ root: dir });
    await assertRejects(
      () => model.methods.check.execute({ paths: [secret] }, ctx),
      Error,
      "cannot read",
    );
  } finally {
    await Deno.chmod(`${dir}`, 0o755).catch(() => {});
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("check: per-call root arg overrides globalArgs.root when scanning all", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/a.ts`, "const S = z.any();\n");
    const ctx = fakeContext({ root: "/never/used" });
    await assertRejects(
      () => model.methods.check.execute({ all: true, root: dir }, ctx),
      Error,
      "unencoded invariant",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
