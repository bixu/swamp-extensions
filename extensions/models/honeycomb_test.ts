import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { model } from "./honeycomb.ts";

// =====================================================================
// Test utilities
// =====================================================================

const globalArgs = {
  teamSlug: "my-team",
  apiKeyId: "hcamk_testkey123",
  apiKeySecret: "key-secret",
  region: "us",
};

// v1 config keys are bare secrets (no prefix)
const TEST_V1_CONFIG_KEY = "test-config-key-secret-value";

const v1GlobalArgs = {
  ...globalArgs,
  configKey: TEST_V1_CONFIG_KEY,
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

// =====================================================================
// get method — v2 environments
// =====================================================================

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

// =====================================================================
// get method — v2 api-keys
// =====================================================================

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

// =====================================================================
// get method — region and output format
// =====================================================================

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
// get method — v1 resources
// =====================================================================

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
// create method — v2
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

// =====================================================================
// create method — v1
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
// update method — v2
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

// =====================================================================
// update method — v1
// =====================================================================

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
// delete method — v2
// =====================================================================

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
// delete method — v1
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
