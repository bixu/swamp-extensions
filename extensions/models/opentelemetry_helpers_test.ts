import { assertEquals } from "jsr:@std/assert@1";
import {
  buildSpan,
  buildTracePayload,
  generateSpanId,
  generateTraceId,
  msToNanos,
  SpanKind,
  spanKindToWire,
  SpanStatusCode,
  statusCodeToWire,
} from "./opentelemetry_helpers.ts";

// StatusCode values match the OTLP proto wire format directly:
// STATUS_CODE_UNSET=0, STATUS_CODE_OK=1, STATUS_CODE_ERROR=2
Deno.test("SpanStatusCode matches OTLP proto values", () => {
  assertEquals(SpanStatusCode.UNSET, 0);
  assertEquals(SpanStatusCode.OK, 1);
  assertEquals(SpanStatusCode.ERROR, 2);
});

// OTel JS API SpanKind is 0-indexed (INTERNAL=0, SERVER=1, CLIENT=2, ...),
// offset by 1 from the OTLP proto wire format (UNSPECIFIED=0, INTERNAL=1,
// SERVER=2, CLIENT=3, ...).
Deno.test("SpanKind has correct API values", () => {
  assertEquals(SpanKind.INTERNAL, 0);
  assertEquals(SpanKind.SERVER, 1);
  assertEquals(SpanKind.CLIENT, 2);
  assertEquals(SpanKind.PRODUCER, 3);
  assertEquals(SpanKind.CONSUMER, 4);
});

Deno.test("spanKindToWire maps API to OTLP wire format", () => {
  assertEquals(spanKindToWire(SpanKind.INTERNAL), 1);
  assertEquals(spanKindToWire(SpanKind.SERVER), 2);
  assertEquals(spanKindToWire(SpanKind.CLIENT), 3);
  assertEquals(spanKindToWire(SpanKind.PRODUCER), 4);
  assertEquals(spanKindToWire(SpanKind.CONSUMER), 5);
});

Deno.test("statusCodeToWire is identity (same values)", () => {
  assertEquals(statusCodeToWire(SpanStatusCode.UNSET), 0);
  assertEquals(statusCodeToWire(SpanStatusCode.OK), 1);
  assertEquals(statusCodeToWire(SpanStatusCode.ERROR), 2);
});

Deno.test("generateTraceId produces 32 hex chars", () => {
  const id = generateTraceId();
  assertEquals(id.length, 32);
  assertEquals(/^[0-9a-f]+$/.test(id), true);
});

Deno.test("generateSpanId produces 16 hex chars", () => {
  const id = generateSpanId();
  assertEquals(id.length, 16);
  assertEquals(/^[0-9a-f]+$/.test(id), true);
});

Deno.test("msToNanos converts correctly", () => {
  assertEquals(msToNanos(1000), "1000000000");
  assertEquals(msToNanos(0), "0");
  assertEquals(msToNanos(1), "1000000");
});

Deno.test("buildSpan creates valid OTLP span", () => {
  const span = buildSpan({
    name: "test-span",
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    kind: SpanKind.SERVER,
    startTimeMs: 1000,
    endTimeMs: 2000,
    status: { code: SpanStatusCode.OK },
    attributes: { "http.method": "GET", "http.status_code": 200 },
  });

  assertEquals(span.name, "test-span");
  assertEquals(span.traceId, "a".repeat(32));
  assertEquals(span.spanId, "b".repeat(16));
  assertEquals(span.kind, 2); // SERVER on wire
  assertEquals(span.startTimeUnixNano, "1000000000");
  assertEquals(span.endTimeUnixNano, "2000000000");
  assertEquals(span.status.code, 1); // OK
  assertEquals(span.attributes.length, 2);
  assertEquals(span.attributes[0].key, "http.method");
  assertEquals(span.attributes[0].value, { stringValue: "GET" });
  assertEquals(span.attributes[1].value, { intValue: 200 });
});

Deno.test("buildSpan generates IDs when not provided", () => {
  const span = buildSpan({
    name: "auto-id",
    startTimeMs: 0,
    endTimeMs: 100,
  });

  assertEquals(span.traceId.length, 32);
  assertEquals(span.spanId.length, 16);
  assertEquals(span.kind, 1); // INTERNAL on wire (default)
  assertEquals(span.status.code, 0); // UNSET (default)
});

Deno.test("buildSpan includes parentSpanId when provided", () => {
  const span = buildSpan({
    name: "child",
    parentSpanId: "c".repeat(16),
    startTimeMs: 0,
    endTimeMs: 100,
  });

  assertEquals(span.parentSpanId, "c".repeat(16));
});

Deno.test("buildSpan omits parentSpanId when not provided", () => {
  const span = buildSpan({
    name: "root",
    startTimeMs: 0,
    endTimeMs: 100,
  });

  assertEquals(span.parentSpanId, undefined);
});

Deno.test("buildTracePayload produces valid OTLP structure", () => {
  const span = buildSpan({
    name: "test",
    startTimeMs: 0,
    endTimeMs: 100,
  });

  const payload = buildTracePayload([span], "my-service");
  // deno-lint-ignore no-explicit-any
  const rs = (payload as any).resourceSpans;

  assertEquals(rs.length, 1);
  assertEquals(rs[0].resource.attributes[0].key, "service.name");
  assertEquals(rs[0].resource.attributes[0].value.stringValue, "my-service");
  assertEquals(rs[0].scopeSpans[0].scope.name, "@bixu/opentelemetry");
  assertEquals(rs[0].scopeSpans[0].spans.length, 1);
  assertEquals(rs[0].scopeSpans[0].spans[0].name, "test");
});
