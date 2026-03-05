import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  getContainerStatus,
  igApi,
  isUrl,
  waitForContainer,
} from "./instagram_helpers.ts";

// --- isUrl ---

Deno.test("isUrl returns true for https URL", () => {
  assertEquals(isUrl("https://example.com/photo.jpg"), true);
});

Deno.test("isUrl returns true for http URL", () => {
  assertEquals(isUrl("http://example.com/photo.jpg"), true);
});

Deno.test("isUrl returns false for local path", () => {
  assertEquals(isUrl("/home/user/photo.jpg"), false);
});

Deno.test("isUrl returns false for relative path", () => {
  assertEquals(isUrl("photos/sunset.jpg"), false);
});

Deno.test("isUrl returns false for empty string", () => {
  assertEquals(isUrl(""), false);
});

Deno.test("isUrl is case-insensitive", () => {
  assertEquals(isUrl("HTTPS://EXAMPLE.COM/photo.jpg"), true);
});

// --- igApi ---

function mockFetch(body: Record<string, unknown>, status = 200): typeof fetch {
  return (() =>
    Promise.resolve(
      new Response(JSON.stringify(body), { status }),
    )) as typeof fetch;
}

Deno.test("igApi returns parsed body on success", async () => {
  const result = await igApi(
    "/12345/media",
    { image_url: "https://example.com/img.jpg" },
    "token123",
    mockFetch({ id: "container-1" }),
  );
  assertEquals(result.id, "container-1");
});

Deno.test("igApi sends access_token as query param", async () => {
  let capturedUrl = "";
  const spy: typeof fetch = ((url: string) => {
    capturedUrl = url;
    return Promise.resolve(
      new Response(JSON.stringify({ id: "1" }), { status: 200 }),
    );
  }) as typeof fetch;

  await igApi("/12345/media", {}, "my-secret-token", spy);
  assertStringIncludes(capturedUrl, "access_token=my-secret-token");
});

Deno.test("igApi sends params as query params", async () => {
  let capturedUrl = "";
  const spy: typeof fetch = ((url: string) => {
    capturedUrl = url;
    return Promise.resolve(
      new Response(JSON.stringify({ id: "1" }), { status: 200 }),
    );
  }) as typeof fetch;

  await igApi(
    "/12345/media",
    { image_url: "https://img.test/a.jpg" },
    "tok",
    spy,
  );
  assertStringIncludes(capturedUrl, "image_url=https");
});

Deno.test("igApi uses POST method", async () => {
  let capturedMethod = "";
  const spy: typeof fetch = ((_url: string, init?: RequestInit) => {
    capturedMethod = init?.method || "";
    return Promise.resolve(
      new Response(JSON.stringify({ id: "1" }), { status: 200 }),
    );
  }) as typeof fetch;

  await igApi("/12345/media", {}, "tok", spy);
  assertEquals(capturedMethod, "POST");
});

Deno.test("igApi throws on API error response", async () => {
  await assertRejects(
    () =>
      igApi(
        "/12345/media",
        {},
        "tok",
        mockFetch({
          error: { message: "Invalid token", code: 190 },
        }),
      ),
    Error,
    "Instagram API error: Invalid token (code 190)",
  );
});

Deno.test("igApi builds correct URL path", async () => {
  let capturedUrl = "";
  const spy: typeof fetch = ((url: string) => {
    capturedUrl = url;
    return Promise.resolve(
      new Response(JSON.stringify({ id: "1" }), { status: 200 }),
    );
  }) as typeof fetch;

  await igApi("/99999/media_publish", { creation_id: "c1" }, "tok", spy);
  assertStringIncludes(
    capturedUrl,
    "https://graph.instagram.com/v22.0/99999/media_publish",
  );
});

// --- getContainerStatus ---

Deno.test("getContainerStatus returns status fields", async () => {
  const result = await getContainerStatus(
    "container-1",
    "tok",
    mockFetch({ status_code: "FINISHED" }),
  );
  assertEquals(result.status_code, "FINISHED");
});

Deno.test("getContainerStatus passes access_token", async () => {
  let capturedUrl = "";
  const spy: typeof fetch = ((url: string) => {
    capturedUrl = url;
    return Promise.resolve(
      new Response(JSON.stringify({ status_code: "IN_PROGRESS" }), {
        status: 200,
      }),
    );
  }) as typeof fetch;

  await getContainerStatus("c1", "secret-tok", spy);
  assertStringIncludes(capturedUrl, "access_token=secret-tok");
});

Deno.test("getContainerStatus requests status_code and status fields", async () => {
  let capturedUrl = "";
  const spy: typeof fetch = ((url: string) => {
    capturedUrl = url;
    return Promise.resolve(
      new Response(JSON.stringify({ status_code: "FINISHED" }), {
        status: 200,
      }),
    );
  }) as typeof fetch;

  await getContainerStatus("c1", "tok", spy);
  assertStringIncludes(capturedUrl, "fields=status_code%2Cstatus");
});

// --- waitForContainer ---

Deno.test("waitForContainer resolves when status is FINISHED", async () => {
  await waitForContainer(
    "c1",
    "tok",
    1,
    mockFetch({ status_code: "FINISHED" }),
  );
  // No error means success
});

Deno.test("waitForContainer throws on ERROR status", async () => {
  await assertRejects(
    () =>
      waitForContainer(
        "c1",
        "tok",
        1,
        mockFetch({ status_code: "ERROR", status: "image too large" }),
      ),
    Error,
    "Container processing failed: image too large",
  );
});

Deno.test("waitForContainer throws on timeout", async () => {
  await assertRejects(
    () =>
      waitForContainer(
        "c1",
        "tok",
        1,
        mockFetch({ status_code: "IN_PROGRESS" }),
      ),
    Error,
    "did not finish processing",
  );
});

Deno.test("waitForContainer uses unknown error for ERROR without status", async () => {
  await assertRejects(
    () =>
      waitForContainer(
        "c1",
        "tok",
        1,
        mockFetch({ status_code: "ERROR" }),
      ),
    Error,
    "unknown error",
  );
});
