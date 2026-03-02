// --- Key validation ---
// v2 Management Key IDs use prefix hc{region}mk_ (e.g. hcamk_ for US).
// v1 Configuration Keys are bare secrets with no prefix — the hcalk_
// prefix is only the key ID shown in the Management API, not part of
// the actual key value used for auth.
// See: https://docs.honeycomb.io/get-started/best-practices/api-keys/

const V2_KEY_PATTERN = /^hc.mk_/;

function redactKey(key: string): string {
  return key.length > 10 ? key.slice(0, 10) + "..." : key;
}

export function validateV2KeyId(apiKeyId: string): void {
  if (!V2_KEY_PATTERN.test(apiKeyId)) {
    throw new Error(
      `apiKeyId "${
        redactKey(apiKeyId)
      }" does not look like a v2 Management Key ID ` +
        `(expected prefix matching "hc{region}mk_", e.g. "hcamk_" for US).`,
    );
  }
}

export function validateV1ConfigKey(configKey: string): void {
  // Config keys are bare secrets — reject if someone accidentally
  // passes a key ID (which has a Honeycomb prefix) instead of the secret.
  if (V2_KEY_PATTERN.test(configKey)) {
    throw new Error(
      `configKey looks like a v2 Management Key ID (prefix "${
        configKey.slice(0, 6)
      }"). ` +
        `configKey should be the Configuration Key secret, not a Management Key ID.`,
    );
  }
  if (configKey.length === 0) {
    throw new Error("configKey is empty");
  }
}

export function baseUrl(region: string): string {
  return region === "eu"
    ? "https://api.eu1.honeycomb.io"
    : "https://api.honeycomb.io";
}

export function authHeaders(
  apiKeyId: string,
  apiKeySecret: string,
): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKeyId}:${apiKeySecret}`,
    Accept: "application/vnd.api+json",
    "Content-Type": "application/json",
  };
}

export function resourceUrl(
  base: string,
  teamSlug: string,
  resource: string,
): string {
  return `${base}/2/teams/${encodeURIComponent(teamSlug)}/${
    encodeURIComponent(resource)
  }`;
}

export function connectionInfo(globalArgs: {
  teamSlug: string;
  apiKeyId: string;
  apiKeySecret: string;
  region: string;
}) {
  const teamSlug = String(globalArgs.teamSlug).trim();
  const apiKeyId = String(globalArgs.apiKeyId).trim();
  const apiKeySecret = String(globalArgs.apiKeySecret).trim();
  validateV2KeyId(apiKeyId);
  const region = globalArgs.region;
  const base = baseUrl(region);
  const headers = authHeaders(apiKeyId, apiKeySecret);
  return { teamSlug, base, headers };
}

export function mapApiItem(
  item: { id: string; type?: string; attributes?: Record<string, unknown> },
  fallbackType: string,
): { instanceName: string; data: Record<string, unknown> } {
  const instanceName = item.attributes?.slug as string ?? item.id;
  return {
    instanceName,
    data: {
      id: item.id,
      type: item.type ?? fallbackType,
      attributes: item.attributes ?? {},
    },
  };
}

const HIDDEN_KEYS = new Set(["timestamps", "slug"]);

function flattenAttributes(
  attrs: Record<string, unknown>,
  prefix = "",
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(attrs)) {
    if (!prefix && HIDDEN_KEYS.has(key)) continue;
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (val === undefined || val === null) {
      result[fullKey] = "";
    } else if (typeof val === "object" && !Array.isArray(val)) {
      Object.assign(
        result,
        flattenAttributes(val as Record<string, unknown>, fullKey),
      );
    } else if (typeof val === "boolean") {
      result[fullKey] = val ? "true" : "false";
    } else {
      result[fullKey] = String(val);
    }
  }
  return result;
}

export function buildSummaryTable(
  _resource: string,
  items: Array<{
    id: string;
    type?: string;
    attributes?: Record<string, unknown>;
  }>,
): string[] {
  if (items.length === 0) {
    return ["(no results)"];
  }

  // Flatten nested attributes into dot-notation columns
  const flatRows = items.map((item) =>
    flattenAttributes(item.attributes ?? {})
  );

  // Collect all keys across items, name first
  const keySet = new Set<string>();
  for (const row of flatRows) {
    for (const key of Object.keys(row)) {
      keySet.add(key);
    }
  }
  keySet.delete("name");
  const columns = ["name", ...keySet];

  // Build rows
  const rows = flatRows.map((flat) => columns.map((col) => flat[col] ?? ""));

  // Calculate column widths
  const widths = columns.map((col, i) =>
    Math.max(col.length, ...rows.map((r) => r[i].length))
  );

  const pad = (s: string, w: number) => s.padEnd(w);
  const top = "+" + widths.map((w) => "-".repeat(w + 2)).join("+") + "+";
  const row = (cells: string[]) =>
    "|" + cells.map((c, i) => " " + pad(c, widths[i]) + " ").join("|") + "|";

  const lines = [top, row(columns), top];
  for (const r of rows) {
    lines.push(row(r));
  }
  lines.push(top);

  return lines;
}

// --- v1 API support ---

export function authHeadersV1(
  configKey: string,
): Record<string, string> {
  return {
    "X-Honeycomb-Team": configKey,
    "Content-Type": "application/json",
  };
}

export function resourceUrlV1(
  base: string,
  resource: string,
  datasetSlug?: string,
): string {
  if (datasetSlug) {
    return `${base}/1/${encodeURIComponent(resource)}/${
      encodeURIComponent(datasetSlug)
    }`;
  }
  return `${base}/1/${encodeURIComponent(resource)}`;
}

export const V1_RESOURCE_REGISTRY: Record<
  string,
  { datasetScoped: boolean }
> = {
  "datasets": { datasetScoped: false },
  "dataset-definitions": { datasetScoped: true },
};

const V1_API_PATH_MAP: Record<string, string> = {
  "dataset-definitions": "dataset_definitions",
};

export function resolveV1Request(
  base: string,
  resource: string,
  dataset?: string,
): string {
  const entry = V1_RESOURCE_REGISTRY[resource];
  if (!entry) {
    throw new Error(`Unknown v1 resource: ${resource}`);
  }
  if (entry.datasetScoped && !dataset) {
    throw new Error(
      `Resource "${resource}" requires a dataset argument`,
    );
  }
  const apiPath = V1_API_PATH_MAP[resource] ?? resource;
  return resourceUrlV1(
    base,
    apiPath,
    entry.datasetScoped ? dataset : undefined,
  );
}

export function mapV1Item(
  item: Record<string, unknown>,
  resource: string,
  index: number,
): { instanceName: string; data: Record<string, unknown> } {
  const instanceName = (item.slug as string) ??
    (item.name as string) ??
    `${resource}-${index}`;
  return {
    instanceName,
    data: {
      type: resource,
      attributes: item,
    },
  };
}

export function findByNameOrSlug(
  items: Array<{
    id: string;
    attributes?: { name?: string; slug?: string } & Record<string, unknown>;
  }>,
  name: string,
) {
  return items.find((item) =>
    item.attributes?.name === name ||
    item.attributes?.slug === name
  );
}
