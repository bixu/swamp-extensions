import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { extension as proposeExtension } from "./policy_propose.ts";

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

const propose = proposeExtension.methods[0].propose;

Deno.test("propose writes HuJSON verbatim and describes the change", async () => {
  const dir = await Deno.makeTempDir();
  const sourcePath = `${dir}/proposed.hujson`;
  const targetPath = `${dir}/policy.hujson`;
  const text = '{\n  // keep me\n  "acls": [],\n}\n';
  await Deno.writeTextFile(sourcePath, text);
  const ctx = fakeContext(LIVE);
  await propose.execute(
    { sourcePath, targetPath, liveInstance: "current" },
    ctx,
  );
  assertEquals(await Deno.readTextFile(targetPath), text);
  const data = ctx.written[0].data as Record<string, unknown>;
  assertEquals(data.changed, true);
  assertEquals(data.commentsPresent, true);
  assertEquals(data.differences, [{ section: "acls", state: "changed" }]);
  await Deno.remove(dir, { recursive: true });
});
