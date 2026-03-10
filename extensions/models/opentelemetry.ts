import { z } from "npm:zod@4";
import {
  context,
  flushTracer,
  getTracer,
  initTracer,
  SpanKind,
  SpanStatusCode,
} from "./opentelemetry_helpers.ts";

const GlobalArgsSchema = z.object({
  endpoint: z.string().describe(
    "OTLP/HTTP endpoint (e.g. https://api.honeycomb.io)",
  ),
  serviceName: z.string().default("swamp").describe(
    "OpenTelemetry service.name resource attribute",
  ),
  headers: z.string().optional().describe(
    'JSON object of extra headers (e.g. for auth: {"x-honeycomb-team": "..."})',
  ),
});

const SpanSchema = z.object({
  traceId: z.string(),
  spanId: z.string(),
  name: z.string(),
  status: z.string(),
  durationMs: z.number(),
  attributes: z.record(z.unknown()),
});

export const model = {
  type: "@bixu/opentelemetry",
  version: "2026.03.10.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    span: {
      description: "Exported trace span",
      schema: SpanSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
  },
  methods: {
    trace: {
      description:
        "Create and export a trace span. Wraps a logical operation with timing and attributes.",
      arguments: z.object({
        name: z.string().describe("Span name (e.g. 'deploy.create')"),
        kind: z
          .enum(["internal", "server", "client", "producer", "consumer"])
          .default("internal")
          .describe("Span kind"),
        traceId: z.string().optional().describe(
          "Trace ID to join an existing trace (omit to start a new trace)",
        ),
        parentSpanId: z.string().optional().describe(
          "Parent span ID for nested spans",
        ),
        attributes: z.string().default("{}").describe(
          "JSON object of span attributes",
        ),
        status: z
          .enum(["ok", "error", "unset"])
          .default("ok")
          .describe("Span status"),
        statusMessage: z.string().optional().describe(
          "Status message (typically for errors)",
        ),
        durationMs: z.number().default(0).describe(
          "Span duration in ms. 0 records an instant event.",
        ),
      }),
      execute: async (args, context_) => {
        const parsedHeaders = context_.globalArgs.headers
          ? JSON.parse(context_.globalArgs.headers)
          : undefined;

        initTracer({
          endpoint: context_.globalArgs.endpoint,
          serviceName: context_.globalArgs.serviceName,
          headers: parsedHeaders,
        });

        const tracer = getTracer(context_.globalArgs.serviceName);
        const spanKindMap = {
          internal: SpanKind.INTERNAL,
          server: SpanKind.SERVER,
          client: SpanKind.CLIENT,
          producer: SpanKind.PRODUCER,
          consumer: SpanKind.CONSUMER,
        };
        const statusMap = {
          ok: SpanStatusCode.OK,
          error: SpanStatusCode.ERROR,
          unset: SpanStatusCode.UNSET,
        };

        const parsedAttrs = JSON.parse(args.attributes);
        const now = Date.now();
        const startTime = new Date(now - args.durationMs);

        const span = tracer.startSpan(
          args.name,
          {
            kind: spanKindMap[args.kind],
            startTime,
            attributes: parsedAttrs,
          },
          context.active(),
        );

        span.setStatus({
          code: statusMap[args.status],
          message: args.statusMessage,
        });
        span.end(new Date(now));

        await flushTracer();

        const spanContext = span.spanContext();

        context_.logger.info("Exported span {name} ({traceId})", {
          name: args.name,
          traceId: spanContext.traceId,
        });

        const handle = await context_.writeResource("span", args.name, {
          traceId: spanContext.traceId,
          spanId: spanContext.spanId,
          name: args.name,
          status: args.status,
          durationMs: args.durationMs,
          attributes: parsedAttrs,
        });

        return { dataHandles: [handle] };
      },
    },
  },
};
