/** Check whether a string looks like a URL (vs a local file path). */
export function isUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/** POST to the Instagram Graph API. */
export async function igApi(
  path: string,
  params: Record<string, string>,
  accessToken: string,
  fetchFn: typeof fetch = fetch,
) {
  const url = new URL(`https://graph.instagram.com/v22.0${path}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  url.searchParams.set("access_token", accessToken);

  const resp = await fetchFn(url.toString(), { method: "POST" });
  const body = await resp.json();
  if (body.error) {
    throw new Error(
      `Instagram API error: ${body.error.message} (code ${body.error.code})`,
    );
  }
  return body;
}

/** GET the status of a media container. */
export async function getContainerStatus(
  containerId: string,
  accessToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ status_code: string; status?: string }> {
  const url = new URL(
    `https://graph.instagram.com/v22.0/${containerId}`,
  );
  url.searchParams.set("fields", "status_code,status");
  url.searchParams.set("access_token", accessToken);

  const resp = await fetchFn(url.toString());
  return await resp.json();
}

/**
 * Poll a media container until its status is FINISHED.
 * Throws on ERROR or timeout.
 */
export async function waitForContainer(
  containerId: string,
  accessToken: string,
  maxAttempts = 30,
  fetchFn: typeof fetch = fetch,
) {
  for (let i = 0; i < maxAttempts; i++) {
    const body = await getContainerStatus(containerId, accessToken, fetchFn);

    if (body.status_code === "FINISHED") return;
    if (body.status_code === "ERROR") {
      throw new Error(
        `Container processing failed: ${body.status || "unknown error"}`,
      );
    }

    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(
    `Container ${containerId} did not finish processing after ${
      maxAttempts * 2
    }s`,
  );
}
