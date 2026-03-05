import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assertOk,
  authHeaders,
  authHeadersV1,
  baseUrl,
  buildSummaryTable,
  connectionInfo,
  findByNameOrSlug,
  findV1ItemByName,
  mapApiItem,
  mapV1Item,
  resolveV1ItemUrl,
  resolveV1Request,
  resourceUrl,
  resourceUrlV1,
  v1ItemId,
  validateV1ConfigKey,
  validateV2KeyId,
} from "./honeycomb_helpers.ts";
import { model } from "./honeycomb.ts";

// --- assertOk ---

Deno.test("assertOk does nothing for a successful response", async () => {
  const resp = new Response("ok", { status: 200 });
  await assertOk(resp); // should not throw
});

Deno.test("assertOk throws with status and body for a failed response", async () => {
  const resp = new Response("Not Found", { status: 404 });
  await assertRejects(
    () => assertOk(resp),
    Error,
    "Honeycomb API error 404: Not Found",
  );
});

Deno.test("assertOk includes response body in error message", async () => {
  const resp = new Response('{"error":"forbidden"}', { status: 403 });
  await assertRejects(
    () => assertOk(resp),
    Error,
    '{"error":"forbidden"}',
  );
});

// --- baseUrl ---

Deno.test("baseUrl returns US endpoint for us region", () => {
  assertEquals(baseUrl("us"), "https://api.honeycomb.io");
});

Deno.test("baseUrl returns EU endpoint for eu region", () => {
  assertEquals(baseUrl("eu"), "https://api.eu1.honeycomb.io");
});

Deno.test("baseUrl defaults to US for unknown region", () => {
  assertEquals(baseUrl("ap"), "https://api.honeycomb.io");
});

// --- authHeaders ---

Deno.test("authHeaders builds Bearer token from key pair", () => {
  const headers = authHeaders("key-id", "key-secret");
  assertEquals(headers.Authorization, "Bearer key-id:key-secret");
});

Deno.test("authHeaders includes JSON:API accept header", () => {
  const headers = authHeaders("id", "secret");
  assertEquals(headers.Accept, "application/vnd.api+json");
});

Deno.test("authHeaders includes content-type header", () => {
  const headers = authHeaders("id", "secret");
  assertEquals(headers["Content-Type"], "application/vnd.api+json");
});

// --- resourceUrl ---

Deno.test("resourceUrl builds correct path", () => {
  assertEquals(
    resourceUrl("https://api.honeycomb.io", "my-team", "environments"),
    "https://api.honeycomb.io/2/teams/my-team/environments",
  );
});

Deno.test("resourceUrl encodes team slug", () => {
  const url = resourceUrl("https://api.honeycomb.io", "my team", "datasets");
  assertEquals(url.includes("my%20team"), true);
});

Deno.test("resourceUrl encodes resource type", () => {
  const url = resourceUrl(
    "https://api.honeycomb.io",
    "team",
    "some resource",
  );
  assertEquals(url.includes("some%20resource"), true);
});

// --- connectionInfo ---

Deno.test("connectionInfo trims whitespace from credentials", () => {
  const info = connectionInfo({
    teamSlug: "  my-team  ",
    apiKeyId: "  hcamk_test123  ",
    apiKeySecret: "  key-secret  ",
    region: "us",
  });
  assertEquals(info.teamSlug, "my-team");
  assertEquals(
    info.headers.Authorization,
    "Bearer hcamk_test123:key-secret",
  );
});

Deno.test("connectionInfo uses EU base for eu region", () => {
  const info = connectionInfo({
    teamSlug: "team",
    apiKeyId: "hcamk_test123",
    apiKeySecret: "secret",
    region: "eu",
  });
  assertEquals(info.base, "https://api.eu1.honeycomb.io");
});

Deno.test("connectionInfo uses US base for us region", () => {
  const info = connectionInfo({
    teamSlug: "team",
    apiKeyId: "hcamk_test123",
    apiKeySecret: "secret",
    region: "us",
  });
  assertEquals(info.base, "https://api.honeycomb.io");
});

// --- validateV2KeyId ---

Deno.test("validateV2KeyId accepts US management key prefix", () => {
  validateV2KeyId("hcamk_01abc123");
});

Deno.test("validateV2KeyId accepts EU management key prefix", () => {
  validateV2KeyId("hcemk_01abc123");
});

Deno.test("validateV2KeyId rejects config key prefix", () => {
  let threw = false;
  try {
    validateV2KeyId("hcalk_01abc123");
  } catch (e) {
    threw = true;
    assertEquals(
      (e as Error).message.includes("does not look like a v2 Management Key"),
      true,
    );
  }
  assertEquals(threw, true);
});

Deno.test("validateV2KeyId rejects arbitrary string", () => {
  let threw = false;
  try {
    validateV2KeyId("some-random-key");
  } catch (e) {
    threw = true;
    assertEquals(
      (e as Error).message.includes("does not look like a v2 Management Key"),
      true,
    );
  }
  assertEquals(threw, true);
});

// --- validateV1ConfigKey ---

Deno.test("validateV1ConfigKey accepts bare secret string", () => {
  validateV1ConfigKey("NcGRfh40mzATnUl8KojQoF");
});

Deno.test("validateV1ConfigKey rejects management key ID", () => {
  let threw = false;
  try {
    validateV1ConfigKey("hcamk_01test00000000000000000000");
  } catch (e) {
    threw = true;
    assertEquals(
      (e as Error).message.includes("looks like a v2 Management Key ID"),
      true,
    );
  }
  assertEquals(threw, true);
});

Deno.test("validateV1ConfigKey rejects empty string", () => {
  let threw = false;
  try {
    validateV1ConfigKey("");
  } catch (e) {
    threw = true;
    assertEquals(
      (e as Error).message.includes("configKey is empty"),
      true,
    );
  }
  assertEquals(threw, true);
});

Deno.test("connectionInfo rejects non-management key", () => {
  let threw = false;
  try {
    connectionInfo({
      teamSlug: "team",
      apiKeyId: "hcalk_configkey",
      apiKeySecret: "secret",
      region: "us",
    });
  } catch (e) {
    threw = true;
    assertEquals(
      (e as Error).message.includes("does not look like a v2 Management Key"),
      true,
    );
  }
  assertEquals(threw, true);
});

// --- mapApiItem ---

Deno.test("mapApiItem uses slug as instanceName when available", () => {
  const result = mapApiItem(
    { id: "abc-123", type: "environments", attributes: { slug: "prod" } },
    "environments",
  );
  assertEquals(result.instanceName, "prod");
});

Deno.test("mapApiItem falls back to id when no slug", () => {
  const result = mapApiItem(
    { id: "abc-123", type: "environments", attributes: {} },
    "environments",
  );
  assertEquals(result.instanceName, "abc-123");
});

Deno.test("mapApiItem falls back to id when no attributes", () => {
  const result = mapApiItem(
    { id: "abc-123" },
    "environments",
  );
  assertEquals(result.instanceName, "abc-123");
});

Deno.test("mapApiItem preserves item type", () => {
  const result = mapApiItem(
    { id: "1", type: "environments", attributes: { name: "prod" } },
    "fallback",
  );
  assertEquals(result.data.type, "environments");
});

Deno.test("mapApiItem uses fallback type when item has no type", () => {
  const result = mapApiItem(
    { id: "1", attributes: { name: "prod" } },
    "datasets",
  );
  assertEquals(result.data.type, "datasets");
});

Deno.test("mapApiItem includes id in data", () => {
  const result = mapApiItem(
    { id: "abc-123", type: "environments", attributes: {} },
    "environments",
  );
  assertEquals(result.data.id, "abc-123");
});

Deno.test("mapApiItem includes attributes in data", () => {
  const attrs = { name: "prod", color: "blue", slug: "prod" };
  const result = mapApiItem(
    { id: "1", type: "environments", attributes: attrs },
    "environments",
  );
  assertEquals(result.data.attributes, attrs);
});

Deno.test("mapApiItem defaults attributes to empty object", () => {
  const result = mapApiItem({ id: "1" }, "environments");
  assertEquals(result.data.attributes, {});
});

// --- findByNameOrSlug ---

const items = [
  { id: "1", attributes: { name: "Production", slug: "prod" } },
  { id: "2", attributes: { name: "Staging", slug: "staging" } },
  { id: "3", attributes: { name: "Development", slug: "dev" } },
];

Deno.test("findByNameOrSlug matches by name", () => {
  const result = findByNameOrSlug(items, "Production");
  assertEquals(result?.id, "1");
});

Deno.test("findByNameOrSlug matches by slug", () => {
  const result = findByNameOrSlug(items, "staging");
  assertEquals(result?.id, "2");
});

Deno.test("findByNameOrSlug returns undefined for no match", () => {
  const result = findByNameOrSlug(items, "nonexistent");
  assertEquals(result, undefined);
});

Deno.test("findByNameOrSlug returns undefined for empty list", () => {
  const result = findByNameOrSlug([], "anything");
  assertEquals(result, undefined);
});

Deno.test("findByNameOrSlug handles items without attributes", () => {
  const sparse = [{ id: "1" }, { id: "2", attributes: { name: "Found" } }];
  const result = findByNameOrSlug(sparse, "Found");
  assertEquals(result?.id, "2");
});

// --- buildSummaryTable ---

Deno.test("buildSummaryTable returns no results for empty list", () => {
  const lines = buildSummaryTable("environments", []);
  assertEquals(lines, ["(no results)"]);
});

Deno.test("buildSummaryTable puts name column first", () => {
  const lines = buildSummaryTable("environments", [
    { id: "1", attributes: { color: "red", name: "Prod" } },
  ]);
  const header = lines[1];
  assertEquals(header.indexOf("name") < header.indexOf("color"), true);
});

Deno.test("buildSummaryTable excludes timestamps and slug columns", () => {
  const lines = buildSummaryTable("environments", [
    {
      id: "1",
      attributes: {
        name: "Prod",
        slug: "prod",
        timestamps: { created: "2026-01-01", updated: "2026-01-02" },
      },
    },
  ]);
  const header = lines[1];
  assertEquals(header.includes("slug"), false);
  assertEquals(header.includes("timestamps"), false);
});

Deno.test("buildSummaryTable flattens nested objects", () => {
  const lines = buildSummaryTable("environments", [
    {
      id: "1",
      attributes: { name: "Prod", settings: { delete_protected: true } },
    },
  ]);
  const header = lines[1];
  assertEquals(header.includes("settings.delete_protected"), true);
  const dataRow = lines[3];
  assertEquals(dataRow.includes("true"), true);
});

Deno.test("buildSummaryTable shows multiple rows", () => {
  const lines = buildSummaryTable("environments", [
    { id: "1", attributes: { name: "Prod", color: "red" } },
    { id: "2", attributes: { name: "Staging", color: "yellow" } },
  ]);
  // top, header, separator, row1, row2, bottom = 6 lines
  assertEquals(lines.length, 6);
  assertEquals(lines[3].includes("Prod"), true);
  assertEquals(lines[4].includes("Staging"), true);
});

Deno.test("buildSummaryTable handles boolean values", () => {
  const lines = buildSummaryTable("test", [
    { id: "1", attributes: { name: "X", active: true, disabled: false } },
  ]);
  const dataRow = lines[3];
  assertEquals(dataRow.includes("true"), true);
  assertEquals(dataRow.includes("false"), true);
});

Deno.test("buildSummaryTable uses key_name as primary column when no name present", () => {
  const lines = buildSummaryTable("columns", [
    { id: "1", attributes: { key_name: "duration_ms", type: "float" } },
    { id: "2", attributes: { key_name: "status_code", type: "integer" } },
  ]);
  // Header row should start with key_name
  assertEquals(lines[1].includes("key_name"), true);
  assertEquals(lines[1].includes("type"), true);
  // Data row should have the key_name values
  assertEquals(lines[3].includes("duration_ms"), true);
  assertEquals(lines[4].includes("status_code"), true);
});

// --- get method (stubbed fetch) ---

const globalArgs = {
  teamSlug: "my-team",
  apiKeyId: "hcamk_testkey123",
  apiKeySecret: "key-secret",
  region: "us",
};

function mockContext() {
  const written: Array<{ spec: string; instance: string; data: unknown }> = [];
  let handleCounter = 0;
  return {
    written,
    context: {
      globalArgs,
      writeResource: (spec: string, instance: string, data: unknown) => {
        written.push({ spec, instance, data });
        return Promise.resolve(`handle-${++handleCounter}`);
      },
      logger: { info: () => {} },
    },
  };
}

function stubFetch(
  responses: Array<{ ok: boolean; body: unknown; status?: number }>,
) {
  let callIndex = 0;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const resp = responses[callIndex++] ?? responses[responses.length - 1];
    return Promise.resolve({
      ok: resp.ok,
      status: resp.status ?? (resp.ok ? 200 : 500),
      json: () => Promise.resolve(resp.body),
      text: () => Promise.resolve(JSON.stringify(resp.body)),
    });
  }) as typeof globalThis.fetch;

  return { calls, restore: () => globalThis.fetch = originalFetch };
}

// -- environments --

Deno.test("get lists environments and writes each as a resource", async () => {
  const { context, written } = mockContext();
  const stub = stubFetch([{
    ok: true,
    body: {
      data: [
        {
          id: "env-1",
          type: "environments",
          attributes: {
            name: "Production",
            slug: "prod",
            description: "Production environment",
            color: "red",
            settings: { delete_protected: true },
          },
        },
        {
          id: "env-2",
          type: "environments",
          attributes: {
            name: "Staging",
            slug: "staging",
            description: "Staging environment",
            color: "yellow",
            settings: { delete_protected: false },
          },
        },
      ],
      links: {},
    },
  }]);

  try {
    const result = await model.methods.get.execute(
      { resource: "environments" },
      context,
    );

    assertEquals(result.dataHandles.length, 2);
    assertEquals(written.length, 2);
    assertEquals(written[0].instance, "prod");
    assertEquals(written[0].spec, "resource");
    assertEquals((written[0].data as { id: string }).id, "env-1");
    assertEquals(written[1].instance, "staging");
    assertEquals(
      stub.calls[0].url,
      "https://api.honeycomb.io/2/teams/my-team/environments",
    );
  } finally {
    stub.restore();
  }
});

Deno.test("get follows pagination links for environments", async () => {
  const { context, written } = mockContext();
  const stub = stubFetch([
    {
      ok: true,
      body: {
        data: [{
          id: "env-1",
          type: "environments",
          attributes: { name: "Prod", slug: "prod" },
        }],
        links: { next: "/2/teams/my-team/environments?page[after]=env-1" },
      },
    },
    {
      ok: true,
      body: {
        data: [{
          id: "env-2",
          type: "environments",
          attributes: { name: "Staging", slug: "staging" },
        }],
        links: {},
      },
    },
  ]);

  try {
    const result = await model.methods.get.execute(
      { resource: "environments" },
      context,
    );

    assertEquals(result.dataHandles.length, 2);
    assertEquals(written.length, 2);
    assertEquals(stub.calls.length, 2);
    assertEquals(
      stub.calls[1].url,
      "https://api.honeycomb.io/2/teams/my-team/environments?page[after]=env-1",
    );
  } finally {
    stub.restore();
  }
});

Deno.test("get handles empty environments list", async () => {
  const { context, written } = mockContext();
  const stub = stubFetch([{
    ok: true,
    body: { data: [], links: {} },
  }]);

  try {
    const result = await model.methods.get.execute(
      { resource: "environments" },
      context,
    );

    assertEquals(result.dataHandles.length, 0);
    assertEquals(written.length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test("get throws on API error for environments", async () => {
  const { context } = mockContext();
  const stub = stubFetch([{
    ok: false,
    status: 403,
    body: "Forbidden",
  }]);

  try {
    await assertRejects(
      () => model.methods.get.execute({ resource: "environments" }, context),
      Error,
      "Honeycomb API error 403",
    );
  } finally {
    stub.restore();
  }
});

// -- api-keys --

Deno.test("get lists api-keys and writes each as a resource", async () => {
  const { context, written } = mockContext();
  const stub = stubFetch([{
    ok: true,
    body: {
      data: [
        {
          id: "key-1",
          type: "api-keys",
          attributes: {
            name: "Ingest Key",
            slug: "ingest-key",
            scope: { environments: "all" },
          },
        },
        {
          id: "key-2",
          type: "api-keys",
          attributes: {
            name: "Query Key",
            slug: "query-key",
            scope: { environments: "all" },
          },
        },
      ],
      links: {},
    },
  }]);

  try {
    const result = await model.methods.get.execute(
      { resource: "api-keys" },
      context,
    );

    assertEquals(result.dataHandles.length, 2);
    assertEquals(written.length, 2);
    assertEquals(written[0].instance, "ingest-key");
    assertEquals((written[0].data as { type: string }).type, "api-keys");
    assertEquals(written[1].instance, "query-key");
    assertEquals(
      stub.calls[0].url,
      "https://api.honeycomb.io/2/teams/my-team/api-keys",
    );
  } finally {
    stub.restore();
  }
});

Deno.test("get uses id as instance name when api-key has no slug", async () => {
  const { context, written } = mockContext();
  const stub = stubFetch([{
    ok: true,
    body: {
      data: [{
        id: "key-abc",
        type: "api-keys",
        attributes: { name: "Legacy Key" },
      }],
      links: {},
    },
  }]);

  try {
    await model.methods.get.execute({ resource: "api-keys" }, context);

    assertEquals(written[0].instance, "key-abc");
  } finally {
    stub.restore();
  }
});

Deno.test("get handles empty api-keys list", async () => {
  const { context, written } = mockContext();
  const stub = stubFetch([{
    ok: true,
    body: { data: [], links: {} },
  }]);

  try {
    const result = await model.methods.get.execute(
      { resource: "api-keys" },
      context,
    );

    assertEquals(result.dataHandles.length, 0);
    assertEquals(written.length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test("get throws on API error for api-keys", async () => {
  const { context } = mockContext();
  const stub = stubFetch([{
    ok: false,
    status: 401,
    body: "Unauthorized",
  }]);

  try {
    await assertRejects(
      () => model.methods.get.execute({ resource: "api-keys" }, context),
      Error,
      "Honeycomb API error 401",
    );
  } finally {
    stub.restore();
  }
});

// -- EU region --

Deno.test("get uses EU endpoint when region is eu", async () => {
  const euContext = {
    globalArgs: { ...globalArgs, region: "eu" },
    writeResource: () => Promise.resolve("handle"),
    logger: { info: () => {} },
  };
  const stub = stubFetch([{
    ok: true,
    body: { data: [], links: {} },
  }]);

  try {
    await model.methods.get.execute({ resource: "environments" }, euContext);

    assertEquals(
      stub.calls[0].url,
      "https://api.eu1.honeycomb.io/2/teams/my-team/environments",
    );
  } finally {
    stub.restore();
  }
});

// -- json output --

Deno.test("get with json=true writes JSON to stdout", async () => {
  const { context } = mockContext();
  const envData = [
    {
      id: "env-1",
      type: "environments",
      attributes: { name: "Prod", slug: "prod" },
    },
  ];
  const stub = stubFetch([{
    ok: true,
    body: { data: envData, links: {} },
  }]);

  const chunks: Uint8Array[] = [];
  const originalWrite = Deno.stdout.write.bind(Deno.stdout);
  Deno.stdout.write = (p: Uint8Array) => {
    chunks.push(p);
    return Promise.resolve(p.length);
  };

  try {
    await model.methods.get.execute(
      { resource: "environments", json: true },
      context,
    );

    const output = new TextDecoder().decode(chunks[0]);
    const parsed = JSON.parse(output);
    assertEquals(parsed.length, 1);
    assertEquals(parsed[0].id, "env-1");
    assertEquals(parsed[0].attributes.name, "Prod");
  } finally {
    Deno.stdout.write = originalWrite;
    stub.restore();
  }
});

Deno.test("get with json=true writes empty array for no results", async () => {
  const { context } = mockContext();
  const stub = stubFetch([{
    ok: true,
    body: { data: [], links: {} },
  }]);

  const chunks: Uint8Array[] = [];
  const originalWrite = Deno.stdout.write.bind(Deno.stdout);
  Deno.stdout.write = (p: Uint8Array) => {
    chunks.push(p);
    return Promise.resolve(p.length);
  };

  try {
    await model.methods.get.execute(
      { resource: "environments", json: true },
      context,
    );

    const output = new TextDecoder().decode(chunks[0]);
    const parsed = JSON.parse(output);
    assertEquals(parsed.length, 0);
  } finally {
    Deno.stdout.write = originalWrite;
    stub.restore();
  }
});

Deno.test("get with json=false writes ASCII table (default behavior)", async () => {
  const { context } = mockContext();
  const stub = stubFetch([{
    ok: true,
    body: {
      data: [{
        id: "env-1",
        type: "environments",
        attributes: { name: "Prod", slug: "prod" },
      }],
      links: {},
    },
  }]);

  const chunks: Uint8Array[] = [];
  const originalWrite = Deno.stdout.write.bind(Deno.stdout);
  Deno.stdout.write = (p: Uint8Array) => {
    chunks.push(p);
    return Promise.resolve(p.length);
  };

  try {
    await model.methods.get.execute(
      { resource: "environments", json: false },
      context,
    );

    const output = new TextDecoder().decode(chunks[0]);
    // ASCII table output should NOT be valid JSON
    assertEquals(output.startsWith("["), false);
    // Should contain the table content
    assertEquals(output.includes("Prod"), true);
  } finally {
    Deno.stdout.write = originalWrite;
    stub.restore();
  }
});

Deno.test("get sends correct auth headers", async () => {
  const { context } = mockContext();
  const stub = stubFetch([{
    ok: true,
    body: { data: [], links: {} },
  }]);

  try {
    await model.methods.get.execute({ resource: "environments" }, context);

    const headers = stub.calls[0].init?.headers as Record<string, string>;
    assertEquals(
      headers.Authorization,
      "Bearer hcamk_testkey123:key-secret",
    );
    assertEquals(headers.Accept, "application/vnd.api+json");
  } finally {
    stub.restore();
  }
});

// =====================================================================
// v1 API helpers
// =====================================================================

// --- authHeadersV1 ---

Deno.test("authHeadersV1 returns X-Honeycomb-Team header", () => {
  const headers = authHeadersV1("my-config-key");
  assertEquals(headers["X-Honeycomb-Team"], "my-config-key");
});

Deno.test("authHeadersV1 includes content-type header", () => {
  const headers = authHeadersV1("key");
  assertEquals(headers["Content-Type"], "application/json");
});

// --- resourceUrlV1 ---

Deno.test("resourceUrlV1 builds environment-scoped path", () => {
  assertEquals(
    resourceUrlV1("https://api.honeycomb.io", "datasets"),
    "https://api.honeycomb.io/1/datasets",
  );
});

Deno.test("resourceUrlV1 builds dataset-scoped path", () => {
  assertEquals(
    resourceUrlV1("https://api.honeycomb.io", "dataset_definitions", "my-ds"),
    "https://api.honeycomb.io/1/dataset_definitions/my-ds",
  );
});

Deno.test("resourceUrlV1 encodes resource and dataset", () => {
  const url = resourceUrlV1(
    "https://api.honeycomb.io",
    "some resource",
    "my dataset",
  );
  assertEquals(url.includes("some%20resource"), true);
  assertEquals(url.includes("my%20dataset"), true);
});

// --- resolveV1Request ---

Deno.test("resolveV1Request resolves datasets URL", () => {
  const url = resolveV1Request("https://api.honeycomb.io", "datasets");
  assertEquals(url, "https://api.honeycomb.io/1/datasets");
});

Deno.test("resolveV1Request resolves dataset-definitions with dataset slug", () => {
  const url = resolveV1Request(
    "https://api.honeycomb.io",
    "dataset-definitions",
    "my-ds",
  );
  assertEquals(url, "https://api.honeycomb.io/1/dataset_definitions/my-ds");
});

Deno.test("resolveV1Request throws for unknown resource", () => {
  let threw = false;
  try {
    resolveV1Request("https://api.honeycomb.io", "unknown-thing");
  } catch (e) {
    threw = true;
    assertEquals((e as Error).message, "Unknown v1 resource: unknown-thing");
  }
  assertEquals(threw, true);
});

Deno.test("resolveV1Request appends slug for slugFilterable resource", () => {
  const url = resolveV1Request(
    "https://api.honeycomb.io",
    "datasets",
    "my-dataset",
  );
  assertEquals(url, "https://api.honeycomb.io/1/datasets/my-dataset");
});

Deno.test("resolveV1Request omits slug for datasets when not provided", () => {
  const url = resolveV1Request("https://api.honeycomb.io", "datasets");
  assertEquals(url, "https://api.honeycomb.io/1/datasets");
});

Deno.test("resolveV1Request throws when dataset missing for dataset-scoped resource", () => {
  let threw = false;
  try {
    resolveV1Request("https://api.honeycomb.io", "dataset-definitions");
  } catch (e) {
    threw = true;
    assertEquals(
      (e as Error).message,
      'Resource "dataset-definitions" requires a dataset argument',
    );
  }
  assertEquals(threw, true);
});

Deno.test("resolveV1Request resolves triggers with dataset slug", () => {
  const url = resolveV1Request(
    "https://api.honeycomb.io",
    "triggers",
    "my-ds",
  );
  assertEquals(url, "https://api.honeycomb.io/1/triggers/my-ds");
});

Deno.test("resolveV1Request throws when dataset missing for triggers", () => {
  let threw = false;
  try {
    resolveV1Request("https://api.honeycomb.io", "triggers");
  } catch (e) {
    threw = true;
    assertEquals(
      (e as Error).message,
      'Resource "triggers" requires a dataset argument',
    );
  }
  assertEquals(threw, true);
});

Deno.test("resolveV1Request resolves boards without dataset", () => {
  const url = resolveV1Request(
    "https://api.honeycomb.io",
    "boards",
  );
  assertEquals(url, "https://api.honeycomb.io/1/boards");
});

Deno.test("resolveV1Request resolves recipients without dataset", () => {
  const url = resolveV1Request(
    "https://api.honeycomb.io",
    "recipients",
  );
  assertEquals(url, "https://api.honeycomb.io/1/recipients");
});

Deno.test("resolveV1Request resolves columns with dataset slug", () => {
  const url = resolveV1Request(
    "https://api.honeycomb.io",
    "columns",
    "my-ds",
  );
  assertEquals(url, "https://api.honeycomb.io/1/columns/my-ds");
});

Deno.test("resolveV1Request throws when dataset missing for columns", () => {
  let threw = false;
  try {
    resolveV1Request("https://api.honeycomb.io", "columns");
  } catch (e) {
    threw = true;
    assertEquals(
      (e as Error).message,
      'Resource "columns" requires a dataset argument',
    );
  }
  assertEquals(threw, true);
});

Deno.test("resolveV1Request resolves derived-columns with dataset slug", () => {
  const url = resolveV1Request(
    "https://api.honeycomb.io",
    "derived-columns",
    "my-ds",
  );
  assertEquals(url, "https://api.honeycomb.io/1/derived_columns/my-ds");
});

Deno.test("resolveV1Request throws when dataset missing for derived-columns", () => {
  let threw = false;
  try {
    resolveV1Request("https://api.honeycomb.io", "derived-columns");
  } catch (e) {
    threw = true;
    assertEquals(
      (e as Error).message,
      'Resource "derived-columns" requires a dataset argument',
    );
  }
  assertEquals(threw, true);
});

// --- mapV1Item ---

Deno.test("mapV1Item uses slug as instanceName when available", () => {
  const result = mapV1Item(
    { slug: "my-ds", name: "My Dataset" },
    "datasets",
    0,
  );
  assertEquals(result.instanceName, "my-ds");
});

Deno.test("mapV1Item falls back to name when no slug", () => {
  const result = mapV1Item({ name: "My Dataset" }, "datasets", 0);
  assertEquals(result.instanceName, "My Dataset");
});

Deno.test("mapV1Item falls back to resource-index when no slug or name", () => {
  const result = mapV1Item({ foo: "bar" }, "datasets", 3);
  assertEquals(result.instanceName, "datasets-3");
});

Deno.test("mapV1Item sets type from resource", () => {
  const result = mapV1Item({ slug: "x" }, "datasets", 0);
  assertEquals(result.data.type, "datasets");
});

Deno.test("mapV1Item does not include id in data", () => {
  const result = mapV1Item({ slug: "my-ds" }, "datasets", 0);
  assertEquals("id" in result.data, false);
});

Deno.test("mapV1Item stores full item as attributes", () => {
  const item = { slug: "x", name: "X", extra: 42 };
  const result = mapV1Item(item, "datasets", 0);
  assertEquals(result.data.attributes, item);
});

// =====================================================================
// v1 get method tests
// =====================================================================

// v1 config keys are bare secrets (no prefix)
const TEST_V1_CONFIG_KEY = "test-config-key-secret-value";

const v1GlobalArgs = {
  ...globalArgs,
  configKey: TEST_V1_CONFIG_KEY,
};

function mockV1Context() {
  const written: Array<{ spec: string; instance: string; data: unknown }> = [];
  let handleCounter = 0;
  return {
    written,
    context: {
      globalArgs: v1GlobalArgs,
      writeResource: (spec: string, instance: string, data: unknown) => {
        written.push({ spec, instance, data });
        return Promise.resolve(`handle-${++handleCounter}`);
      },
      logger: { info: () => {} },
    },
  };
}

Deno.test("get with datasets uses v1 auth and writes resources", async () => {
  const { context, written } = mockV1Context();
  const stub = stubFetch([{
    ok: true,
    body: [
      { slug: "backend", name: "Backend", created_at: "2026-01-01" },
      { slug: "frontend", name: "Frontend", created_at: "2026-01-02" },
    ],
  }]);

  try {
    const result = await model.methods.get.execute(
      { resource: "datasets" },
      context,
    );

    assertEquals(result.dataHandles.length, 2);
    assertEquals(written.length, 2);
    assertEquals(written[0].instance, "backend");
    assertEquals(written[1].instance, "frontend");
    assertEquals(written[0].spec, "v1resource");

    // Verify v1 auth headers
    const headers = stub.calls[0].init?.headers as Record<string, string>;
    assertEquals(headers["X-Honeycomb-Team"], TEST_V1_CONFIG_KEY);
    assertEquals(headers["Content-Type"], "application/json");

    // Verify v1 URL
    assertEquals(
      stub.calls[0].url,
      "https://api.honeycomb.io/1/datasets",
    );
  } finally {
    stub.restore();
  }
});

Deno.test("get with dataset-definitions normalizes object response", async () => {
  const { context, written } = mockV1Context();
  const stub = stubFetch([{
    ok: true,
    body: {
      "duration_ms": { name: "duration_ms", type: "float" },
      "status_code": { name: "status_code", type: "integer" },
    },
  }]);

  try {
    const result = await model.methods.get.execute(
      { resource: "dataset-definitions", dataset: "backend" },
      context,
    );

    assertEquals(result.dataHandles.length, 2);
    assertEquals(written.length, 2);
    assertEquals(written[0].instance, "duration_ms");
    assertEquals(written[1].instance, "status_code");

    // Verify dataset-scoped URL
    assertEquals(
      stub.calls[0].url,
      "https://api.honeycomb.io/1/dataset_definitions/backend",
    );
  } finally {
    stub.restore();
  }
});

Deno.test("get with dataset-definitions throws when dataset missing", async () => {
  const { context } = mockV1Context();

  await assertRejects(
    () =>
      model.methods.get.execute(
        { resource: "dataset-definitions" },
        context,
      ),
    Error,
    "requires a dataset argument",
  );
});

Deno.test("get with v1 resource throws when configKey missing", async () => {
  const { context } = mockContext(); // no configKey

  await assertRejects(
    () =>
      model.methods.get.execute(
        { resource: "datasets" },
        context,
      ),
    Error,
    "requires configKey",
  );
});

Deno.test("get with datasets handles empty array", async () => {
  const { context, written } = mockV1Context();
  const stub = stubFetch([{
    ok: true,
    body: [],
  }]);

  try {
    const result = await model.methods.get.execute(
      { resource: "datasets" },
      context,
    );

    assertEquals(result.dataHandles.length, 0);
    assertEquals(written.length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test("get with datasets throws on API error", async () => {
  const { context } = mockV1Context();
  const stub = stubFetch([{
    ok: false,
    status: 401,
    body: "Unauthorized",
  }]);

  try {
    await assertRejects(
      () =>
        model.methods.get.execute(
          { resource: "datasets" },
          context,
        ),
      Error,
      "Honeycomb API error 401",
    );
  } finally {
    stub.restore();
  }
});

Deno.test("get with datasets and dataset slug fetches single dataset", async () => {
  const { context, written } = mockV1Context();
  const stub = stubFetch([{
    ok: true,
    body: {
      slug: "backend",
      name: "Backend",
      created_at: "2026-01-01",
      last_written_at: "2026-03-01",
    },
  }]);

  try {
    const result = await model.methods.get.execute(
      { resource: "datasets", dataset: "backend" },
      context,
    );

    assertEquals(result.dataHandles.length, 1);
    assertEquals(written.length, 1);
    assertEquals(written[0].instance, "backend");
    assertEquals(written[0].spec, "v1resource");

    // Verify slug-filtered URL
    assertEquals(
      stub.calls[0].url,
      "https://api.honeycomb.io/1/datasets/backend",
    );
  } finally {
    stub.restore();
  }
});

Deno.test("get with v1 resource throws when configKey is a management key ID", async () => {
  const badKeyContext = {
    globalArgs: {
      ...globalArgs,
      configKey: "hcamk_01test00000000000000000000",
    },
    writeResource: () => Promise.resolve("handle"),
    logger: { info: () => {} },
  };

  await assertRejects(
    () =>
      model.methods.get.execute(
        { resource: "datasets" },
        badKeyContext,
      ),
    Error,
    "looks like a v2 Management Key ID",
  );
});

// =====================================================================
// resolveV1ItemUrl
// =====================================================================

Deno.test("resolveV1ItemUrl builds global resource item URL", () => {
  assertEquals(
    resolveV1ItemUrl("https://api.honeycomb.io", "boards", "abc-123"),
    "https://api.honeycomb.io/1/boards/abc-123",
  );
});

Deno.test("resolveV1ItemUrl builds dataset-scoped resource item URL", () => {
  assertEquals(
    resolveV1ItemUrl(
      "https://api.honeycomb.io",
      "triggers",
      "trig-1",
      "my-ds",
    ),
    "https://api.honeycomb.io/1/triggers/my-ds/trig-1",
  );
});

Deno.test("resolveV1ItemUrl maps hyphenated resource names to API paths", () => {
  assertEquals(
    resolveV1ItemUrl(
      "https://api.honeycomb.io",
      "derived-columns",
      "dc-1",
      "my-ds",
    ),
    "https://api.honeycomb.io/1/derived_columns/my-ds/dc-1",
  );
});

Deno.test("resolveV1ItemUrl throws for unknown resource", () => {
  let threw = false;
  try {
    resolveV1ItemUrl("https://api.honeycomb.io", "unknown", "id-1");
  } catch (e) {
    threw = true;
    assertEquals((e as Error).message, "Unknown v1 resource: unknown");
  }
  assertEquals(threw, true);
});

Deno.test("resolveV1ItemUrl throws when dataset missing for dataset-scoped resource", () => {
  let threw = false;
  try {
    resolveV1ItemUrl("https://api.honeycomb.io", "columns", "col-1");
  } catch (e) {
    threw = true;
    assertEquals(
      (e as Error).message,
      'Resource "columns" requires a dataset argument',
    );
  }
  assertEquals(threw, true);
});

Deno.test("resolveV1ItemUrl encodes id and dataset", () => {
  const url = resolveV1ItemUrl(
    "https://api.honeycomb.io",
    "triggers",
    "id with spaces",
    "ds with spaces",
  );
  assertEquals(url.includes("id%20with%20spaces"), true);
  assertEquals(url.includes("ds%20with%20spaces"), true);
});

Deno.test("resolveV1ItemUrl builds datasets item URL using slug", () => {
  assertEquals(
    resolveV1ItemUrl("https://api.honeycomb.io", "datasets", "my-ds"),
    "https://api.honeycomb.io/1/datasets/my-ds",
  );
});

// =====================================================================
// findV1ItemByName
// =====================================================================

Deno.test("findV1ItemByName matches by name", () => {
  const items = [{ name: "My Board", id: "b-1" }];
  assertEquals(findV1ItemByName(items, "My Board")?.id, "b-1");
});

Deno.test("findV1ItemByName matches by slug", () => {
  const items = [{ slug: "backend", name: "Backend", id: "d-1" }];
  assertEquals(findV1ItemByName(items, "backend")?.id, "d-1");
});

Deno.test("findV1ItemByName matches by id", () => {
  const items = [{ name: "Thing", id: "abc-123" }];
  assertEquals(findV1ItemByName(items, "abc-123")?.name, "Thing");
});

Deno.test("findV1ItemByName matches by alias (derived-columns)", () => {
  const items = [{ alias: "my_derived", id: "dc-1" }];
  assertEquals(findV1ItemByName(items, "my_derived")?.id, "dc-1");
});

Deno.test("findV1ItemByName matches by key_name (columns)", () => {
  const items = [{ key_name: "duration_ms", id: "col-1" }];
  assertEquals(findV1ItemByName(items, "duration_ms")?.id, "col-1");
});

Deno.test("findV1ItemByName returns undefined for no match", () => {
  const items = [{ name: "A", id: "1" }];
  assertEquals(findV1ItemByName(items, "nonexistent"), undefined);
});

Deno.test("findV1ItemByName returns undefined for empty list", () => {
  assertEquals(findV1ItemByName([], "anything"), undefined);
});

// =====================================================================
// v1ItemId
// =====================================================================

Deno.test("v1ItemId returns slug for datasets", () => {
  assertEquals(v1ItemId({ slug: "my-ds", id: "123" }, "datasets"), "my-ds");
});

Deno.test("v1ItemId returns id for non-dataset resources", () => {
  assertEquals(
    v1ItemId({ id: "trig-1", name: "My Trigger" }, "triggers"),
    "trig-1",
  );
});

Deno.test("v1ItemId returns id for boards", () => {
  assertEquals(v1ItemId({ id: "b-1", name: "My Board" }, "boards"), "b-1");
});

// =====================================================================
// create v1 method tests
// =====================================================================

Deno.test("create throws for read-only v1 resource (dataset-definitions)", async () => {
  const { context } = mockV1Context();

  await assertRejects(
    () =>
      model.methods.create.execute(
        { resource: "dataset-definitions", name: "test", dataset: "my-ds" },
        context,
      ),
    Error,
    '"dataset-definitions" is a read-only v1 resource',
  );
});

Deno.test("create v1 resource posts to collection URL", async () => {
  const { context, written } = mockV1Context();
  const stub = stubFetch([{
    ok: true,
    body: { id: "b-1", name: "My Board" },
  }]);

  try {
    const result = await model.methods.create.execute(
      { resource: "boards", name: "My Board" },
      context,
    );

    assertEquals(result.dataHandles.length, 1);
    assertEquals(written[0].spec, "v1resource");
    assertEquals(written[0].instance, "My Board");
    assertEquals(stub.calls[0].url, "https://api.honeycomb.io/1/boards");
    assertEquals(stub.calls[0].init?.method, "POST");

    const sentBody = JSON.parse(stub.calls[0].init?.body as string);
    assertEquals(sentBody.name, "My Board");
  } finally {
    stub.restore();
  }
});

Deno.test("create v1 resource uses body arg when provided", async () => {
  const { context } = mockV1Context();
  const stub = stubFetch([{
    ok: true,
    body: { id: "t-1", name: "CPU Alert", threshold: { op: ">", value: 90 } },
  }]);

  try {
    await model.methods.create.execute(
      {
        resource: "triggers",
        name: "CPU Alert",
        dataset: "backend",
        body: JSON.stringify({
          name: "CPU Alert",
          threshold: { op: ">", value: 90 },
        }),
      },
      context,
    );

    const sentBody = JSON.parse(stub.calls[0].init?.body as string);
    assertEquals(sentBody.threshold.op, ">");
    assertEquals(sentBody.threshold.value, 90);
    assertEquals(
      stub.calls[0].url,
      "https://api.honeycomb.io/1/triggers/backend",
    );
  } finally {
    stub.restore();
  }
});

Deno.test("create v1 resource requires configKey", async () => {
  const { context } = mockContext(); // no configKey

  await assertRejects(
    () =>
      model.methods.create.execute(
        { resource: "boards", name: "test" },
        context,
      ),
    Error,
    "requires configKey",
  );
});

// =====================================================================
// update method tests
// =====================================================================

Deno.test("update v2 resource patches by id after lookup", async () => {
  const { context, written } = mockContext();
  const stub = stubFetch([
    {
      ok: true,
      body: {
        data: [{
          id: "env-1",
          type: "environments",
          attributes: { name: "cicd", slug: "cicd" },
        }],
        links: {},
      },
    },
    {
      ok: true,
      body: {
        data: {
          id: "env-1",
          type: "environments",
          attributes: {
            name: "cicd",
            slug: "cicd",
            settings: { delete_protected: false },
          },
        },
      },
    },
  ]);

  try {
    const result = await model.methods.update.execute(
      {
        resource: "environments",
        name: "cicd",
        body: JSON.stringify({ settings: { delete_protected: false } }),
      },
      context,
    );

    assertEquals(result.dataHandles.length, 1);
    assertEquals(written[0].spec, "resource");
    assertEquals(stub.calls[1].init?.method, "PATCH");
    assertEquals(
      stub.calls[1].url,
      "https://api.honeycomb.io/2/teams/my-team/environments/env-1",
    );

    const sentBody = JSON.parse(stub.calls[1].init?.body as string);
    assertEquals(sentBody.data.type, "environments");
    assertEquals(sentBody.data.id, "env-1");
    assertEquals(sentBody.data.attributes.settings.delete_protected, false);
  } finally {
    stub.restore();
  }
});

Deno.test("update v2 resource throws when not found", async () => {
  const { context } = mockContext();
  const stub = stubFetch([{
    ok: true,
    body: { data: [], links: {} },
  }]);

  try {
    await assertRejects(
      () =>
        model.methods.update.execute(
          {
            resource: "environments",
            name: "nonexistent",
            body: JSON.stringify({ color: "red" }),
          },
          context,
        ),
      Error,
      'No environments found matching "nonexistent"',
    );
  } finally {
    stub.restore();
  }
});

Deno.test("update v1 resource puts to item URL after lookup", async () => {
  const { context, written } = mockV1Context();
  const stub = stubFetch([
    {
      ok: true,
      body: [
        { id: "b-1", name: "My Board" },
      ],
    },
    {
      ok: true,
      body: { id: "b-1", name: "Updated Board" },
    },
  ]);

  try {
    const result = await model.methods.update.execute(
      {
        resource: "boards",
        name: "My Board",
        body: JSON.stringify({ name: "Updated Board" }),
      },
      context,
    );

    assertEquals(result.dataHandles.length, 1);
    assertEquals(written[0].spec, "v1resource");
    assertEquals(stub.calls[1].init?.method, "PUT");
    assertEquals(
      stub.calls[1].url,
      "https://api.honeycomb.io/1/boards/b-1",
    );
  } finally {
    stub.restore();
  }
});

Deno.test("update v1 dataset-scoped resource includes dataset in URL", async () => {
  const { context } = mockV1Context();
  const stub = stubFetch([
    {
      ok: true,
      body: [{ id: "t-1", name: "CPU Alert" }],
    },
    {
      ok: true,
      body: { id: "t-1", name: "CPU Alert", threshold: { value: 95 } },
    },
  ]);

  try {
    await model.methods.update.execute(
      {
        resource: "triggers",
        name: "CPU Alert",
        dataset: "backend",
        body: JSON.stringify({ threshold: { value: 95 } }),
      },
      context,
    );

    assertEquals(
      stub.calls[1].url,
      "https://api.honeycomb.io/1/triggers/backend/t-1",
    );
  } finally {
    stub.restore();
  }
});

Deno.test("update v1 resource throws when not found", async () => {
  const { context } = mockV1Context();
  const stub = stubFetch([{
    ok: true,
    body: [],
  }]);

  try {
    await assertRejects(
      () =>
        model.methods.update.execute(
          {
            resource: "boards",
            name: "nonexistent",
            body: JSON.stringify({ name: "x" }),
          },
          context,
        ),
      Error,
      'No boards found matching "nonexistent"',
    );
  } finally {
    stub.restore();
  }
});

Deno.test("update throws for read-only v1 resource (dataset-definitions)", async () => {
  const { context } = mockV1Context();

  await assertRejects(
    () =>
      model.methods.update.execute(
        {
          resource: "dataset-definitions",
          name: "test",
          dataset: "my-ds",
          body: JSON.stringify({ x: 1 }),
        },
        context,
      ),
    Error,
    '"dataset-definitions" is a read-only v1 resource',
  );
});

Deno.test("update v1 resource requires configKey", async () => {
  const { context } = mockContext(); // no configKey

  await assertRejects(
    () =>
      model.methods.update.execute(
        {
          resource: "boards",
          name: "test",
          body: JSON.stringify({ name: "x" }),
        },
        context,
      ),
    Error,
    "requires configKey",
  );
});

// =====================================================================
// delete v1 method tests
// =====================================================================

Deno.test("delete v1 resource deletes by item URL after lookup", async () => {
  const { context } = mockV1Context();
  const stub = stubFetch([
    {
      ok: true,
      body: [
        { id: "b-1", name: "My Board" },
        { id: "b-2", name: "Other Board" },
      ],
    },
    { ok: true, body: null },
  ]);

  try {
    const result = await model.methods.delete.execute(
      { resource: "boards", name: "My Board" },
      context,
    );

    assertEquals(result.dataHandles.length, 0);
    assertEquals(stub.calls[1].init?.method, "DELETE");
    assertEquals(
      stub.calls[1].url,
      "https://api.honeycomb.io/1/boards/b-1",
    );
  } finally {
    stub.restore();
  }
});

Deno.test("delete v1 dataset-scoped resource includes dataset in URL", async () => {
  const { context } = mockV1Context();
  const stub = stubFetch([
    {
      ok: true,
      body: [{ id: "col-1", key_name: "duration_ms" }],
    },
    { ok: true, body: null },
  ]);

  try {
    await model.methods.delete.execute(
      { resource: "columns", name: "duration_ms", dataset: "backend" },
      context,
    );

    assertEquals(
      stub.calls[1].url,
      "https://api.honeycomb.io/1/columns/backend/col-1",
    );
  } finally {
    stub.restore();
  }
});

Deno.test("delete v1 datasets uses slug as id", async () => {
  const { context } = mockV1Context();
  const stub = stubFetch([
    {
      ok: true,
      body: [
        { slug: "my-ds", name: "My Dataset" },
      ],
    },
    { ok: true, body: null },
  ]);

  try {
    await model.methods.delete.execute(
      { resource: "datasets", name: "my-ds" },
      context,
    );

    assertEquals(
      stub.calls[1].url,
      "https://api.honeycomb.io/1/datasets/my-ds",
    );
  } finally {
    stub.restore();
  }
});

Deno.test("delete v1 resource throws when not found", async () => {
  const { context } = mockV1Context();
  const stub = stubFetch([{
    ok: true,
    body: [],
  }]);

  try {
    await assertRejects(
      () =>
        model.methods.delete.execute(
          { resource: "boards", name: "nonexistent" },
          context,
        ),
      Error,
      'No boards found matching "nonexistent"',
    );
  } finally {
    stub.restore();
  }
});

Deno.test("delete throws for read-only v1 resource (dataset-definitions)", async () => {
  const { context } = mockV1Context();

  await assertRejects(
    () =>
      model.methods.delete.execute(
        { resource: "dataset-definitions", name: "test", dataset: "my-ds" },
        context,
      ),
    Error,
    '"dataset-definitions" is a read-only v1 resource',
  );
});

Deno.test("delete v1 resource requires configKey", async () => {
  const { context } = mockContext(); // no configKey

  await assertRejects(
    () =>
      model.methods.delete.execute(
        { resource: "boards", name: "test" },
        context,
      ),
    Error,
    "requires configKey",
  );
});

// =====================================================================
// v2 create / delete stubbed integration tests
// =====================================================================

Deno.test("create v2 resource posts JSON:API body and writes resource", async () => {
  const { context, written } = mockContext();
  const stub = stubFetch([{
    ok: true,
    body: {
      data: {
        id: "env-new",
        type: "environments",
        attributes: { name: "test-env", slug: "test-env", color: "gold" },
      },
    },
  }]);

  try {
    const result = await model.methods.create.execute(
      { resource: "environments", name: "test-env" },
      context,
    );

    assertEquals(result.dataHandles.length, 1);
    assertEquals(written[0].spec, "resource");
    assertEquals(written[0].instance, "test-env");
    assertEquals(stub.calls[0].init?.method, "POST");
    assertEquals(
      stub.calls[0].url,
      "https://api.honeycomb.io/2/teams/my-team/environments",
    );

    const sentBody = JSON.parse(stub.calls[0].init?.body as string);
    assertEquals(sentBody.data.type, "environments");
    assertEquals(sentBody.data.attributes.name, "test-env");
  } finally {
    stub.restore();
  }
});

Deno.test("create v2 resource uses body arg when provided", async () => {
  const { context, written } = mockContext();
  const stub = stubFetch([{
    ok: true,
    body: {
      data: {
        id: "env-new",
        type: "environments",
        attributes: {
          name: "test-env",
          slug: "test-env",
          color: "blue",
          description: "A test",
        },
      },
    },
  }]);

  try {
    await model.methods.create.execute(
      {
        resource: "environments",
        name: "test-env",
        body: JSON.stringify({
          name: "test-env",
          color: "blue",
          description: "A test",
        }),
      },
      context,
    );

    assertEquals(written[0].instance, "test-env");
    const sentBody = JSON.parse(stub.calls[0].init?.body as string);
    assertEquals(sentBody.data.attributes.color, "blue");
    assertEquals(sentBody.data.attributes.description, "A test");
  } finally {
    stub.restore();
  }
});

Deno.test("create v2 resource throws on API error", async () => {
  const { context } = mockContext();
  const stub = stubFetch([{
    ok: false,
    status: 422,
    body: "Validation failed",
  }]);

  try {
    await assertRejects(
      () =>
        model.methods.create.execute(
          { resource: "environments", name: "bad" },
          context,
        ),
      Error,
      "Honeycomb API error 422",
    );
  } finally {
    stub.restore();
  }
});

Deno.test("delete v2 resource finds by name and deletes by id", async () => {
  const { context } = mockContext();
  const stub = stubFetch([
    {
      ok: true,
      body: {
        data: [
          {
            id: "env-1",
            type: "environments",
            attributes: { name: "keep-me", slug: "keep-me" },
          },
          {
            id: "env-2",
            type: "environments",
            attributes: { name: "delete-me", slug: "delete-me" },
          },
        ],
        links: {},
      },
    },
    { ok: true, status: 204, body: null },
  ]);

  try {
    const result = await model.methods.delete.execute(
      { resource: "environments", name: "delete-me" },
      context,
    );

    assertEquals(result.dataHandles.length, 0);
    assertEquals(stub.calls[1].init?.method, "DELETE");
    assertEquals(
      stub.calls[1].url,
      "https://api.honeycomb.io/2/teams/my-team/environments/env-2",
    );
  } finally {
    stub.restore();
  }
});

Deno.test("delete v2 resource throws when not found", async () => {
  const { context } = mockContext();
  const stub = stubFetch([{
    ok: true,
    body: { data: [], links: {} },
  }]);

  try {
    await assertRejects(
      () =>
        model.methods.delete.execute(
          { resource: "environments", name: "nonexistent" },
          context,
        ),
      Error,
      'No environments found matching "nonexistent"',
    );
  } finally {
    stub.restore();
  }
});

// =====================================================================
// update v1 datasets uses slug as item id
// =====================================================================

Deno.test("update v1 datasets uses slug in item URL", async () => {
  const { context } = mockV1Context();
  const stub = stubFetch([
    {
      ok: true,
      body: [
        { slug: "backend", name: "Backend" },
      ],
    },
    {
      ok: true,
      body: { slug: "backend", name: "Backend", description: "Updated" },
    },
  ]);

  try {
    await model.methods.update.execute(
      {
        resource: "datasets",
        name: "backend",
        body: JSON.stringify({ description: "Updated" }),
      },
      context,
    );

    assertEquals(
      stub.calls[1].url,
      "https://api.honeycomb.io/1/datasets/backend",
    );
    assertEquals(stub.calls[1].init?.method, "PUT");
  } finally {
    stub.restore();
  }
});

// =====================================================================
// delete v1 lookup by alias (derived-columns)
// =====================================================================

Deno.test("delete v1 derived-column found by alias", async () => {
  const { context } = mockV1Context();
  const stub = stubFetch([
    {
      ok: true,
      body: [
        { id: "dc-1", alias: "p99_latency" },
        { id: "dc-2", alias: "error_rate" },
      ],
    },
    { ok: true, body: null },
  ]);

  try {
    await model.methods.delete.execute(
      {
        resource: "derived-columns",
        name: "error_rate",
        dataset: "backend",
      },
      context,
    );

    assertEquals(stub.calls[1].init?.method, "DELETE");
    assertEquals(
      stub.calls[1].url,
      "https://api.honeycomb.io/1/derived_columns/backend/dc-2",
    );
  } finally {
    stub.restore();
  }
});
