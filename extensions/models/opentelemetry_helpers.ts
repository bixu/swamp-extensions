/**
 * OpenTelemetry trace helpers.
 *
 * Uses the OTel API for enum types and the OTLP/HTTP JSON wire format
 * for export via fetch(). No SDK exporter dependency — avoids bundler
 * compatibility issues in swamp's Deno runtime.
 */

import { SpanKind, SpanStatusCode, trace } from "npm:@opentelemetry/api@1.9.0";

export { SpanKind, SpanStatusCode, trace };

/** Hex-encode a random byte array. */
function hexBytes(n: number): string {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Generate a 32-hex-char trace ID. */
export function generateTraceId(): string {
  return hexBytes(16);
}

/** Generate a 16-hex-char span ID. */
export function generateSpanId(): string {
  return hexBytes(8);
}

/** Convert milliseconds since epoch to OTLP nanosecond string. */
export function msToNanos(ms: number): string {
  return (BigInt(Math.round(ms)) * 1_000_000n).toString();
}

/**
 * Map OTel API SpanKind (0-indexed) to OTLP wire format (1-indexed).
 * API: INTERNAL=0, SERVER=1, CLIENT=2, PRODUCER=3, CONSUMER=4
 * Wire: UNSPECIFIED=0, INTERNAL=1, SERVER=2, CLIENT=3, PRODUCER=4, CONSUMER=5
 */
export function spanKindToWire(kind: number): number {
  return kind + 1;
}

/**
 * Map OTel API StatusCode to OTLP wire format (same values).
 * Both use: UNSET=0, OK=1, ERROR=2
 */
export function statusCodeToWire(code: number): number {
  return code;
}

/** Convert a typed attribute value to OTLP attribute value format. */
function otlpAttrValue(
  v: string | number | boolean,
): Record<string, unknown> {
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { boolValue: v };
  if (Number.isInteger(v)) return { intValue: v };
  return { doubleValue: v };
}

export interface SpanInput {
  name: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  kind?: number;
  startTimeMs: number;
  endTimeMs: number;
  status?: { code: number; message?: string };
  attributes?: Record<string, string | number | boolean>;
}

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Array<{ key: string; value: Record<string, unknown> }>;
  status: { code: number; message?: string };
}

/** Build an OTLP span object from simplified input. */
export function buildSpan(input: SpanInput): OtlpSpan {
  const traceId = input.traceId ?? generateTraceId();
  const spanId = input.spanId ?? generateSpanId();

  const attributes = Object.entries(input.attributes ?? {}).map(
    ([key, value]) => ({ key, value: otlpAttrValue(value) }),
  );

  const span: OtlpSpan = {
    traceId,
    spanId,
    name: input.name,
    kind: spanKindToWire(input.kind ?? SpanKind.INTERNAL),
    startTimeUnixNano: msToNanos(input.startTimeMs),
    endTimeUnixNano: msToNanos(input.endTimeMs),
    attributes,
    status: input.status
      ? {
        code: statusCodeToWire(input.status.code),
        message: input.status.message,
      }
      : { code: statusCodeToWire(SpanStatusCode.UNSET) },
  };

  if (input.parentSpanId) {
    span.parentSpanId = input.parentSpanId;
  }

  return span;
}

/** Build the full OTLP ExportTraceServiceRequest payload. */
export function buildTracePayload(
  spans: OtlpSpan[],
  serviceName: string,
): Record<string, unknown> {
  return {
    resourceSpans: [{
      resource: {
        attributes: [
          { key: "service.name", value: { stringValue: serviceName } },
        ],
      },
      scopeSpans: [{
        scope: { name: "@bixu/opentelemetry", version: "1.0.0" },
        spans,
      }],
    }],
  };
}

/** Export a trace payload to an OTLP/HTTP endpoint via fetch(). */
export async function exportTrace(
  endpoint: string,
  payload: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<{ ok: boolean; status: number; body: string }> {
  const url = endpoint.endsWith("/v1/traces")
    ? endpoint
    : `${endpoint.replace(/\/$/, "")}/v1/traces`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });

  const body = await resp.text();
  return { ok: resp.ok, status: resp.status, body };
}
