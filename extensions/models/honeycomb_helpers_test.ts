import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  authHeaders,
  authHeadersV1,
  baseUrl,
  buildSummaryTable,
  connectionInfo,
  findByNameOrSlug,
  mapApiItem,
  mapV1Item,
  resolveV1Request,
  resourceUrl,
  resourceUrlV1,
} from "./honeycomb_helpers.ts";
import { model } from "./honeycomb.ts";

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
  assertEquals(headers["Content-Type"], "application/json");
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
    apiKeyId: "  key-id  ",
    apiKeySecret: "  key-secret  ",
    region: "us",
  });
  assertEquals(info.teamSlug, "my-team");
  assertEquals(info.headers.Authorization, "Bearer key-id:key-secret");
});

Deno.test("connectionInfo uses EU base for eu region", () => {
  const info = connectionInfo({
    teamSlug: "team",
    apiKeyId: "id",
    apiKeySecret: "secret",
    region: "eu",
  });
  assertEquals(info.base, "https://api.eu1.honeycomb.io");
});

Deno.test("connectionInfo uses US base for us region", () => {
  const info = connectionInfo({
    teamSlug: "team",
    apiKeyId: "id",
    apiKeySecret: "secret",
    region: "us",
  });
  assertEquals(info.base, "https://api.honeycomb.io");
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

// --- get method (stubbed fetch) ---

const globalArgs = {
  teamSlug: "my-team",
  apiKeyId: "key-id",
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
    assertEquals(headers.Authorization, "Bearer key-id:key-secret");
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

Deno.test("mapV1Item stores full item as attributes", () => {
  const item = { slug: "x", name: "X", extra: 42 };
  const result = mapV1Item(item, "datasets", 0);
  assertEquals(result.data.attributes, item);
});

// =====================================================================
// v1 get method tests
// =====================================================================

const v1GlobalArgs = {
  ...globalArgs,
  configKey: "my-config-key",
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
    assertEquals(written[0].spec, "resource");

    // Verify v1 auth headers
    const headers = stub.calls[0].init?.headers as Record<string, string>;
    assertEquals(headers["X-Honeycomb-Team"], "my-config-key");
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
