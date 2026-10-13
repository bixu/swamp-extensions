import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  canonicalize,
  comparePolicies,
  hasComments,
  parseHujson,
  parseLivePolicy,
} from "./hujson.ts";
import { extension as driftExtension } from "./policy_drift.ts";

// --- hujson ---

Deno.test("parseHujson strips comments and trailing commas, keeps strings", () => {
  assertEquals(
    parseHujson('{\n  // note\n  "a": "http://x", /* b */ "b": [1, 2,],\n}'),
    { a: "http://x", b: [1, 2] },
  );
});

Deno.test("parseHujson keeps commas before brackets inside strings", () => {
  assertEquals(parseHujson('{"a": "x, ]", "b": "y,}",}'), {
    a: "x, ]",
    b: "y,}",
  });
});

Deno.test("hasComments ignores comment markers inside strings", () => {
  assertEquals(hasComments('{"a": "http://x"}'), false);
  assertEquals(hasComments('{"a": 1} // c'), true);
});

Deno.test("canonicalize ignores key order but not array order", () => {
  assertEquals(canonicalize({ a: 1, b: 2 }), canonicalize({ b: 2, a: 1 }));
  assertEquals(canonicalize([1, 2]) === canonicalize([2, 1]), false);
});

Deno.test("comparePolicies reports only-live, only-file, and changed", () => {
  assertEquals(
    comparePolicies({ acls: [1], ssh: [] }, { acls: [2], grants: [] }),
    [
      { section: "acls", state: "changed" },
      { section: "grants", state: "only-file" },
      { section: "ssh", state: "only-live" },
    ],
  );
});

Deno.test("parseLivePolicy reads @swamp/tailscale/policy-file state", () => {
  assertEquals(
    parseLivePolicy({ policy: '{"acls": [], // c\n}', etag: "x" }),
    { acls: [] },
  );
  assertThrows(() => parseLivePolicy({}), Error, "Run the `get` method");
  assertThrows(() => parseLivePolicy({ policy: "[]" }), Error, "object");
});

// --- methods ---

const LIVE = { policy: '{\n  // live\n  "acls": [{"action": "accept"}],\n}' };

function fakeContext(live: Record<string, unknown> | null) {
  const written: { spec: string; name: string; data: unknown }[] = [];
  return {
    written,
    readResource: (_name: string) => Promise.resolve(live),
    writeResource: (spec: string, name: string, data: unknown) => {
      written.push({ spec, name, data });
      return Promise.resolve({ name });
    },
    logger: { info: () => {}, warning: () => {} },
  };
}

const drift = driftExtension.methods[0].drift;

Deno.test("drift is in sync when only comments and key order differ", async () => {
  const dir = await Deno.makeTempDir();
  const policyPath = `${dir}/policy.hujson`;
  await Deno.writeTextFile(policyPath, '{"acls": [{"action": "accept",},],}');
  const ctx = fakeContext(LIVE);
  await drift.execute({ policyPath, liveInstance: "current" }, ctx);
  const data = ctx.written[0].data as Record<string, unknown>;
  assertEquals(ctx.written[0].name, "drift");
  assertEquals(data.inSync, true);
  assertEquals(data.differences, []);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("drift reports changed sections", async () => {
  const dir = await Deno.makeTempDir();
  const policyPath = `${dir}/policy.hujson`;
  await Deno.writeTextFile(policyPath, '{"acls": [], "ssh": []}');
  const ctx = fakeContext(LIVE);
  await drift.execute({ policyPath, liveInstance: "current" }, ctx);
  const data = ctx.written[0].data as Record<string, unknown>;
  assertEquals(data.inSync, false);
  assertEquals(data.differences, [
    { section: "acls", state: "changed" },
    { section: "ssh", state: "only-file" },
  ]);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("drift fails clearly without a live snapshot", async () => {
  await assertRejects(
    () =>
      drift.execute(
        { policyPath: "/nonexistent", liveInstance: "current" },
        fakeContext(null),
      ),
    Error,
    "Run the `get` method",
  );
});
