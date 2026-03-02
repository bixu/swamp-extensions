import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  authHeaders,
  baseUrl,
  buildSummaryTable,
  connectionInfo,
  findByNameOrSlug,
  mapApiItem,
  resourceUrl,
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
