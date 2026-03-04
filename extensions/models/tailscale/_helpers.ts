import { z } from "npm:zod@4";

// Shared global arguments for all @john/tailscale-* models
export const TailscaleGlobalArgsSchema = z.object({
  tailnet: z.string().describe("Tailnet name (org name or '-' for default)"),
  apiKey: z
    .string()
    .optional()
    .describe(
      "Tailscale API key. Use: ${{ vault.get('tailscale', 'API_KEY') }}",
    ),
  oauthClientId: z.string().optional().describe("OAuth client ID"),
  oauthClientSecret: z
    .string()
    .optional()
    .describe(
      "OAuth client secret. Use: ${{ vault.get('tailscale', 'OAUTH_SECRET') }}",
    ),
  oauthScopes: z
    .array(z.string())
    .optional()
    .describe("OAuth scopes, e.g. ['all:read', 'all:write']"),
  baseUrl: z
    .string()
    .default("https://api.tailscale.com")
    .describe("API base URL"),
});

// OAuth token cache keyed by clientId+clientSecret
const oauthTokenCache = new Map<string, { token: string; expiresAt: number }>();

// Fetch an OAuth access token using client credentials grant
async function getOAuthToken(globalArgs) {
  const cacheKey = `${globalArgs.oauthClientId}:${globalArgs.oauthClientSecret}`;
  const now = Date.now();
  const cached = oauthTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > now + 60_000) {
    return cached.token;
  }

  const tokenUrl = `${globalArgs.baseUrl}/api/v2/oauth/token`;
  const params = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: globalArgs.oauthClientId,
    client_secret: globalArgs.oauthClientSecret,
  });

  if (globalArgs.oauthScopes && globalArgs.oauthScopes.length > 0) {
    params.set("scope", globalArgs.oauthScopes.join(" "));
  }

  const resp = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `OAuth token request failed (${resp.status}): ${text}`,
    );
  }

  const data = await resp.json();
  oauthTokenCache.set(cacheKey, {
    token: data.access_token,
    expiresAt: now + (data.expires_in || 3600) * 1000,
  });

  return data.access_token;
}

// Build authorization headers based on available credentials
async function getAuthHeaders(globalArgs) {
  if (globalArgs.apiKey) {
    return { Authorization: `Bearer ${globalArgs.apiKey}` };
  }

  if (globalArgs.oauthClientId && globalArgs.oauthClientSecret) {
    const token = await getOAuthToken(globalArgs);
    return { Authorization: `Bearer ${token}` };
  }

  throw new Error(
    "No authentication configured. Provide either apiKey or oauthClientId + oauthClientSecret.",
  );
}

// Core API helper — makes authenticated requests to the Tailscale API
export async function tsApi(globalArgs, method, path, body, extraHeaders) {
  const url = `${globalArgs.baseUrl}${path}`;
  const authHeaders = await getAuthHeaders(globalArgs);

  const headers = {
    ...authHeaders,
    "Content-Type": "application/json",
    Accept: "application/json",
    ...extraHeaders,
  };

  const options = { method, headers };

  if (body !== undefined && body !== null) {
    options.body = JSON.stringify(body);
  }

  const resp = await fetch(url, options);

  if (!resp.ok) {
    const errorText = await resp.text();
    let errorMessage;
    try {
      const errorBody = JSON.parse(errorText);
      errorMessage = errorBody.message || JSON.stringify(errorBody);
    } catch {
      errorMessage = errorText;
    }
    throw new Error(
      `Tailscale API error ${resp.status} ${method} ${path}: ${errorMessage}`,
    );
  }

  // Some endpoints return 204 No Content
  if (resp.status === 204 || resp.headers.get("content-length") === "0") {
    return null;
  }

  // Always read body as text first to avoid "Body already consumed" errors,
  // then parse as JSON if appropriate.
  const responseText = await resp.text();
  if (!responseText) {
    return null;
  }

  const contentType = resp.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return JSON.parse(responseText);
  }

  return responseText;
}

// Sanitize a string for use as a swamp data instance name
export function sanitizeInstanceName(name) {
  return name
    .replace(/\.\./g, "--")
    .replace(/[/\\]/g, "-")
    .replace(/\0/g, "");
}
