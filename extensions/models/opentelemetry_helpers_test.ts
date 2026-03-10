import { assertEquals, assertExists } from "jsr:@std/assert@1";
import { SpanKind, SpanStatusCode, trace } from "./opentelemetry_helpers.ts";

// StatusCode values match the OTLP proto wire format directly:
// STATUS_CODE_UNSET=0, STATUS_CODE_OK=1, STATUS_CODE_ERROR=2
Deno.test("SpanStatusCode matches OTLP proto values", () => {
  assertEquals(SpanStatusCode.UNSET, 0);
  assertEquals(SpanStatusCode.OK, 1);
  assertEquals(SpanStatusCode.ERROR, 2);
});

// OTel JS SDK SpanKind is 0-indexed (INTERNAL=0, SERVER=1, CLIENT=2, ...),
// offset by 1 from the OTLP proto wire format (UNSPECIFIED=0, INTERNAL=1,
// SERVER=2, CLIENT=3, ...). The SDK exporter handles the translation.
Deno.test("SpanKind has correct SDK values", () => {
  assertEquals(SpanKind.INTERNAL, 0);
  assertEquals(SpanKind.SERVER, 1);
  assertEquals(SpanKind.CLIENT, 2);
  assertEquals(SpanKind.PRODUCER, 3);
  assertEquals(SpanKind.CONSUMER, 4);
});

Deno.test("trace API is re-exported and functional", () => {
  assertExists(trace);
  assertEquals(typeof trace.getTracer, "function");

  // getTracer returns a valid tracer even without a registered provider
  // (falls back to the no-op tracer)
  const tracer = trace.getTracer("test-noop");
  assertExists(tracer);
  assertEquals(typeof tracer.startSpan, "function");
});

Deno.test("no-op tracer produces valid span context", () => {
  const tracer = trace.getTracer("test-noop-spans");
  const span = tracer.startSpan("test-span");
  const ctx = span.spanContext();
  assertExists(ctx.traceId);
  assertExists(ctx.spanId);
  span.end();
});
