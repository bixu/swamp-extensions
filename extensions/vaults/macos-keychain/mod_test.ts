import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  assertVaultExportConformance,
  withMockedCommand,
} from "jsr:@systeminit/swamp-testing";
import { vault } from "./mod.ts";

const NOT_FOUND = {
  stdout: "",
  stderr: "The specified item could not be found in the keychain.",
  code: 44,
} as const;

Deno.test("vault export conforms to VaultProvider interface", () => {
  assertVaultExportConformance(vault, {
    validConfigs: [{ service: "my-app" }, {}],
    invalidConfigs: [{ service: "" }, { service: 42 }],
  });
});

Deno.test("get returns secret value", async () => {
  const { result } = await withMockedCommand(
    [{ stdout: "sk-live-abc123", code: 0 }],
    async () => {
      const provider = vault.createProvider("test", { service: "swamp" });
      return await provider.get("api-key");
    },
  );
  assertEquals(result, "sk-live-abc123");
});

Deno.test("get throws with key and service name when secret is absent", async () => {
  await withMockedCommand([NOT_FOUND], async () => {
    const provider = vault.createProvider("test", { service: "swamp" });
    await assertRejects(
      () => provider.get("missing-key"),
      Error,
      'Secret "missing-key" not found in keychain service "swamp"',
    );
  });
});

Deno.test("put writes secret then creates index for a new key", async () => {
  const { calls } = await withMockedCommand(
    (_cmd, args) => {
      if (args[0] === "add-generic-password") return { stdout: "", code: 0 };
      // find-generic-password for index key → not found yet
      return NOT_FOUND;
    },
    async () => {
      const provider = vault.createProvider("test", { service: "swamp" });
      await provider.put("api-key", "sk-live-abc123");
    },
  );
  // 1: add-generic-password (value), 2: find-generic-password (index), 3: add-generic-password (index)
  assertEquals(calls.length, 3);
});

Deno.test("put overwrites secret without duplicating key in existing index", async () => {
  const { calls } = await withMockedCommand(
    (_cmd, args) => {
      if (args[0] === "add-generic-password") return { stdout: "", code: 0 };
      // find-generic-password for index key → already has "api-key"
      return { stdout: JSON.stringify(["api-key"]), code: 0 };
    },
    async () => {
      const provider = vault.createProvider("test", { service: "swamp" });
      await provider.put("api-key", "sk-rotated");
    },
  );
  // 1: add-generic-password (value), 2: find-generic-password (index) — no third write
  assertEquals(calls.length, 2);
});

Deno.test("list returns empty array when no index entry exists", async () => {
  const { result } = await withMockedCommand([NOT_FOUND], async () => {
    const provider = vault.createProvider("test", { service: "swamp" });
    return await provider.list();
  });
  assertEquals(result, []);
});

Deno.test("list returns stored key names from index", async () => {
  const { result } = await withMockedCommand(
    [{ stdout: JSON.stringify(["db-password", "api-key"]), code: 0 }],
    async () => {
      const provider = vault.createProvider("test", { service: "swamp" });
      return await provider.list();
    },
  );
  assertEquals(result, ["db-password", "api-key"]);
});

Deno.test("list excludes internal index key from results", async () => {
  const { result } = await withMockedCommand(
    [
      {
        stdout: JSON.stringify(["api-key", "__swamp_keychain_index__"]),
        code: 0,
      },
    ],
    async () => {
      const provider = vault.createProvider("test", { service: "swamp" });
      return await provider.list();
    },
  );
  assertEquals(result, ["api-key"]);
});

Deno.test("getName returns vault instance name", () => {
  const provider = vault.createProvider("my-keychain", {});
  assertEquals(provider.getName(), "my-keychain");
});
