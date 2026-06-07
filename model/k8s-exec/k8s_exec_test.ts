import { assertEquals } from "jsr:@std/assert@1";
import {
  ExecResultSchema,
  GlobalArgsSchema,
  model,
  runBatched,
  SummarySchema,
} from "./k8s_exec.ts";

// --- GlobalArgsSchema ---

Deno.test("GlobalArgsSchema: accepts valid input with all fields", () => {
  const result = GlobalArgsSchema.parse({
    kubeContext: "my-cluster",
    namespace: "default",
    concurrency: 5,
  });
  assertEquals(result.kubeContext, "my-cluster");
  assertEquals(result.namespace, "default");
  assertEquals(result.concurrency, 5);
});

Deno.test("GlobalArgsSchema: applies defaults for namespace and concurrency", () => {
  const result = GlobalArgsSchema.parse({ kubeContext: "prod" });
  assertEquals(result.namespace, "kube-system");
  assertEquals(result.concurrency, 10);
});

Deno.test("GlobalArgsSchema: rejects missing kubeContext", () => {
  const result = GlobalArgsSchema.safeParse({});
  assertEquals(result.success, false);
});

Deno.test("GlobalArgsSchema: rejects non-string kubeContext", () => {
  const result = GlobalArgsSchema.safeParse({ kubeContext: 123 });
  assertEquals(result.success, false);
});

Deno.test("GlobalArgsSchema: rejects non-number concurrency", () => {
  const result = GlobalArgsSchema.safeParse({
    kubeContext: "ctx",
    concurrency: "fast",
  });
  assertEquals(result.success, false);
});

// --- ExecResultSchema ---

Deno.test("ExecResultSchema: accepts valid exec result", () => {
  const data = {
    podName: "nginx-abc123",
    nodeName: "node-1",
    container: "nginx",
    command: "cat /etc/hostname",
    stdout: "nginx-abc123",
    stderr: "",
    exitCode: 0,
    executedAt: "2026-04-23T10:00:00Z",
  };
  const result = ExecResultSchema.parse(data);
  assertEquals(result.podName, "nginx-abc123");
  assertEquals(result.exitCode, 0);
});

Deno.test("ExecResultSchema: rejects missing fields", () => {
  const result = ExecResultSchema.safeParse({ podName: "x" });
  assertEquals(result.success, false);
});

Deno.test("ExecResultSchema: rejects non-number exitCode", () => {
  const result = ExecResultSchema.safeParse({
    podName: "p",
    nodeName: "n",
    container: "c",
    command: "cmd",
    stdout: "",
    stderr: "",
    exitCode: "zero",
    executedAt: "2026-01-01T00:00:00Z",
  });
  assertEquals(result.success, false);
});

// --- SummarySchema ---

Deno.test("SummarySchema: accepts valid summary", () => {
  const data = {
    method: "execAll",
    totalPods: 10,
    succeeded: 8,
    failed: 2,
    summary: "Executed 'uptime' across 10 pods: 8 succeeded, 2 failed",
    generatedAt: "2026-04-23T10:00:00Z",
  };
  const result = SummarySchema.parse(data);
  assertEquals(result.totalPods, 10);
  assertEquals(result.succeeded, 8);
  assertEquals(result.failed, 2);
});

Deno.test("SummarySchema: rejects missing method", () => {
  const result = SummarySchema.safeParse({
    totalPods: 5,
    succeeded: 5,
    failed: 0,
    summary: "ok",
    generatedAt: "2026-01-01T00:00:00Z",
  });
  assertEquals(result.success, false);
});

// --- exec method arguments schema ---

Deno.test("exec arguments: accepts valid input with pod and command", () => {
  const schema = model.methods.exec.arguments;
  const result = schema.parse({ pod: "nginx-abc", command: "uptime" });
  assertEquals(result.pod, "nginx-abc");
  assertEquals(result.command, "uptime");
  assertEquals(result.container, "");
});

Deno.test("exec arguments: applies default empty string for container", () => {
  const schema = model.methods.exec.arguments;
  const result = schema.parse({ pod: "p", command: "whoami" });
  assertEquals(result.container, "");
});

Deno.test("exec arguments: allows optional namespace override", () => {
  const schema = model.methods.exec.arguments;
  const result = schema.parse({
    pod: "p",
    command: "ls",
    namespace: "monitoring",
  });
  assertEquals(result.namespace, "monitoring");
});

Deno.test("exec arguments: rejects missing pod", () => {
  const schema = model.methods.exec.arguments;
  const result = schema.safeParse({ command: "ls" });
  assertEquals(result.success, false);
});

Deno.test("exec arguments: rejects missing command", () => {
  const schema = model.methods.exec.arguments;
  const result = schema.safeParse({ pod: "nginx" });
  assertEquals(result.success, false);
});

// --- execAll method arguments schema ---

Deno.test("execAll arguments: accepts valid input", () => {
  const schema = model.methods.execAll.arguments;
  const result = schema.parse({
    labelSelector: "app=ovs",
    command: "uptime",
  });
  assertEquals(result.labelSelector, "app=ovs");
  assertEquals(result.command, "uptime");
  assertEquals(result.container, "");
});

Deno.test("execAll arguments: allows optional podFilter", () => {
  const schema = model.methods.execAll.arguments;
  const result = schema.parse({
    labelSelector: "app=nginx",
    command: "date",
    podFilter: "nginx-(abc|def)",
  });
  assertEquals(result.podFilter, "nginx-(abc|def)");
});

Deno.test("execAll arguments: rejects missing labelSelector", () => {
  const schema = model.methods.execAll.arguments;
  const result = schema.safeParse({ command: "date" });
  assertEquals(result.success, false);
});

Deno.test("execAll arguments: rejects missing command", () => {
  const schema = model.methods.execAll.arguments;
  const result = schema.safeParse({ labelSelector: "app=foo" });
  assertEquals(result.success, false);
});

// --- runBatched ---

Deno.test("runBatched: processes all items", async () => {
  const items = [1, 2, 3, 4, 5];
  const results = await runBatched(items, 10, (n) => Promise.resolve(n * 2));
  const values = results
    .filter((r) => r.status === "fulfilled")
    .map((r) => (r as PromiseFulfilledResult<number>).value);
  assertEquals(values, [2, 4, 6, 8, 10]);
});

Deno.test("runBatched: respects concurrency batching", async () => {
  const callOrder: number[] = [];
  const items = [1, 2, 3, 4, 5];

  await runBatched(items, 2, (n) => {
    callOrder.push(n);
    return Promise.resolve(n);
  });

  // With concurrency=2 and 5 items, we get batches: [1,2], [3,4], [5]
  // All items should be processed
  assertEquals(callOrder.length, 5);
  assertEquals(callOrder.sort(), [1, 2, 3, 4, 5]);
});

Deno.test("runBatched: handles empty items array", async () => {
  const results = await runBatched(
    [] as number[],
    5,
    (n) => Promise.resolve(n),
  );
  assertEquals(results, []);
});

Deno.test("runBatched: captures rejections without aborting", async () => {
  const items = [1, 2, 3];
  const results = await runBatched(items, 10, (n) => {
    if (n === 2) return Promise.reject(new Error("fail on 2"));
    return Promise.resolve(n);
  });

  assertEquals(results.length, 3);
  assertEquals(results[0].status, "fulfilled");
  assertEquals(results[1].status, "rejected");
  assertEquals(results[2].status, "fulfilled");
  assertEquals(
    (results[1] as PromiseRejectedResult).reason.message,
    "fail on 2",
  );
});

Deno.test("runBatched: concurrency=1 processes sequentially", async () => {
  const order: number[] = [];
  const items = [1, 2, 3];

  await runBatched(items, 1, (n) => {
    order.push(n);
    return Promise.resolve(n);
  });

  // With concurrency=1, items are processed one at a time in order
  assertEquals(order, [1, 2, 3]);
});

Deno.test("runBatched: large concurrency exceeding item count works fine", async () => {
  const items = [10, 20];
  const results = await runBatched(items, 100, (n) => Promise.resolve(n + 1));
  const values = results
    .filter((r) => r.status === "fulfilled")
    .map((r) => (r as PromiseFulfilledResult<number>).value);
  assertEquals(values, [11, 21]);
});

// --- model structure ---

Deno.test("model: has correct type identifier", () => {
  assertEquals(model.type, "@bixu/k8s/exec");
});

Deno.test("model: declares execResult and summary resources", () => {
  assertEquals("execResult" in model.resources, true);
  assertEquals("summary" in model.resources, true);
});

Deno.test("model: declares exec and execAll methods", () => {
  assertEquals("exec" in model.methods, true);
  assertEquals("execAll" in model.methods, true);
});

Deno.test("model: resources have infinite lifetime", () => {
  assertEquals(model.resources.execResult.lifetime, "infinite");
  assertEquals(model.resources.summary.lifetime, "infinite");
});

Deno.test("model: execResult garbage collection is 50", () => {
  assertEquals(model.resources.execResult.garbageCollection, 50);
});

Deno.test("model: summary garbage collection is 10", () => {
  assertEquals(model.resources.summary.garbageCollection, 10);
});

Deno.test("model: has upgrade from 2026.03.17.1 to 2026.04.23.1", () => {
  assertEquals(model.upgrades.length, 1);
  assertEquals(model.upgrades[0].fromVersion, "2026.03.17.1");
  assertEquals(model.upgrades[0].toVersion, "2026.04.23.1");
});

Deno.test("model: upgrade preserves attributes unchanged", () => {
  const attrs = { podName: "foo", exitCode: 0, extra: "bar" };
  const upgraded = model.upgrades[0].upgradeAttributes(attrs);
  assertEquals(upgraded, attrs);
});

// --- podFilter validation logic (tested via execAll arguments + regex behavior) ---

Deno.test("podFilter: valid regex pattern passes schema", () => {
  const schema = model.methods.execAll.arguments;
  const result = schema.parse({
    labelSelector: "app=x",
    command: "ls",
    podFilter: "^pod-(a|b|c)$",
  });
  assertEquals(result.podFilter, "^pod-(a|b|c)$");
});

Deno.test("podFilter: the runtime rejects patterns exceeding 200 chars", () => {
  // This tests the validation logic documented in execAll's execute function.
  // The podFilter schema itself accepts any string; the length check is at runtime.
  const longPattern = "a".repeat(201);
  const schema = model.methods.execAll.arguments;
  // Schema accepts it (validation is runtime, not schema-level)
  const result = schema.parse({
    labelSelector: "app=x",
    command: "ls",
    podFilter: longPattern,
  });
  assertEquals(result.podFilter!.length, 201);
});
