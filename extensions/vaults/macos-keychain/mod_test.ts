import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  assertVaultExportConformance,
} from "jsr:@systeminit/swamp-testing@0.20260525.18";
import { vault } from "./mod.ts";

const NOT_FOUND = {
  stdout: "",
  stderr: "The specified item could not be found in the keychain.",
  code: 44,
} as const;

type MockResponse = { stdout: string; code: number; stderr?: string };
type RunResult = { code: number; stdout: string; stderr: string };

/** Build a mock command runner from a fixed response list or a selector fn. */
function mockRunner(
  responses:
    | MockResponse[]
    | ((args: string[]) => MockResponse),
): { run: (args: string[]) => Promise<RunResult>; calls: string[][] } {
  const calls: string[][] = [];
  let callIndex = 0;
  const run = (args: string[]): Promise<RunResult> => {
    calls.push([...args]);
    const resp = Array.isArray(responses)
      ? responses[callIndex++]
      : responses(args);
    return Promise.resolve({ stderr: "", ...resp });
  };
  return { calls, run };
}

Deno.test("vault export conforms to VaultProvider interface", () => {
  assertVaultExportConformance(vault, {
    validConfigs: [{ service: "my-app" }, {}],
    invalidConfigs: [{ service: "" }, { service: 42 }],
  });
});

Deno.test("get returns secret value", async () => {
  const { run } = mockRunner([{ stdout: "sk-live-abc123", code: 0 }]);
  const provider = vault.createProvider("test", { service: "swamp" }, run);
  const result = await provider.get("api-key");
  assertEquals(result, "sk-live-abc123");
});

Deno.test("get throws with key and service name when secret is absent", async () => {
  const { run } = mockRunner([NOT_FOUND]);
  const provider = vault.createProvider("test", { service: "swamp" }, run);
  await assertRejects(
    () => provider.get("missing-key"),
    Error,
    'Secret "missing-key" not found in keychain service "swamp"',
  );
});

Deno.test("put writes secret then creates index for a new key", async () => {
  const { run, calls } = mockRunner((args) => {
    if (args[0] === "add-generic-password") return { stdout: "", code: 0 };
    // find-generic-password for index key → not found yet
    return NOT_FOUND;
  });
  const provider = vault.createProvider("test", { service: "swamp" }, run);
  await provider.put("api-key", "sk-live-abc123");
  // 1: add-generic-password (value), 2: find-generic-password (index), 3: add-generic-password (index)
  assertEquals(calls.length, 3);
});

Deno.test("put overwrites secret without duplicating key in existing index", async () => {
  const { run, calls } = mockRunner((args) => {
    if (args[0] === "add-generic-password") return { stdout: "", code: 0 };
    // find-generic-password for index key → already has "api-key"
    return { stdout: JSON.stringify(["api-key"]), code: 0 };
  });
  const provider = vault.createProvider("test", { service: "swamp" }, run);
  await provider.put("api-key", "sk-rotated");
  // 1: add-generic-password (value), 2: find-generic-password (index) — no third write
  assertEquals(calls.length, 2);
});

Deno.test("list returns empty array when no index entry exists", async () => {
  const { run } = mockRunner([NOT_FOUND]);
  const provider = vault.createProvider("test", { service: "swamp" }, run);
  const result = await provider.list();
  assertEquals(result, []);
});

Deno.test("list returns stored key names from index", async () => {
  const { run } = mockRunner([
    { stdout: JSON.stringify(["db-password", "api-key"]), code: 0 },
  ]);
  const provider = vault.createProvider("test", { service: "swamp" }, run);
  const result = await provider.list();
  assertEquals(result, ["db-password", "api-key"]);
});

Deno.test("list excludes internal index key from results", async () => {
  const { run } = mockRunner([
    {
      stdout: JSON.stringify(["api-key", "__swamp_keychain_index__"]),
      code: 0,
    },
  ]);
  const provider = vault.createProvider("test", { service: "swamp" }, run);
  const result = await provider.list();
  assertEquals(result, ["api-key"]);
});

Deno.test("getName returns vault instance name", () => {
  const provider = vault.createProvider("my-keychain", {});
  assertEquals(provider.getName(), "my-keychain");
});
