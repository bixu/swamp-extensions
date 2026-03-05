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

// --- resolveV1ItemUrl ---

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

// --- findV1ItemByName ---

Deno.test("findV1ItemByName matches by name", () => {
  const v1items = [{ name: "My Board", id: "b-1" }];
  assertEquals(findV1ItemByName(v1items, "My Board")?.id, "b-1");
});

Deno.test("findV1ItemByName matches by slug", () => {
  const v1items = [{ slug: "backend", name: "Backend", id: "d-1" }];
  assertEquals(findV1ItemByName(v1items, "backend")?.id, "d-1");
});

Deno.test("findV1ItemByName matches by id", () => {
  const v1items = [{ name: "Thing", id: "abc-123" }];
  assertEquals(findV1ItemByName(v1items, "abc-123")?.name, "Thing");
});

Deno.test("findV1ItemByName matches by alias (derived-columns)", () => {
  const v1items = [{ alias: "my_derived", id: "dc-1" }];
  assertEquals(findV1ItemByName(v1items, "my_derived")?.id, "dc-1");
});

Deno.test("findV1ItemByName matches by key_name (columns)", () => {
  const v1items = [{ key_name: "duration_ms", id: "col-1" }];
  assertEquals(findV1ItemByName(v1items, "duration_ms")?.id, "col-1");
});

Deno.test("findV1ItemByName returns undefined for no match", () => {
  const v1items = [{ name: "A", id: "1" }];
  assertEquals(findV1ItemByName(v1items, "nonexistent"), undefined);
});

Deno.test("findV1ItemByName returns undefined for empty list", () => {
  assertEquals(findV1ItemByName([], "anything"), undefined);
});

// --- v1ItemId ---

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
