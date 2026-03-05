/** Detect content type from file extension. */
export function contentTypeFromPath(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase();
  const types: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    pdf: "application/pdf",
    json: "application/json",
    txt: "text/plain",
    html: "text/html",
    css: "text/css",
    js: "application/javascript",
    csv: "text/csv",
    xml: "application/xml",
    zip: "application/zip",
    gz: "application/gzip",
    tar: "application/x-tar",
  };
  return types[ext || ""] || "application/octet-stream";
}

/** Build the S3 object key. Prefixes with optional prefix, uses filename. */
export function buildKey(filePath: string, prefix?: string): string {
  const filename = filePath.split("/").pop()!;
  if (prefix) {
    const clean = prefix.replace(/^\/+|\/+$/g, "");
    return `${clean}/${filename}`;
  }
  return filename;
}
