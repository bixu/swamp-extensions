import { z } from "npm:zod@4";
import {
  buildSpan,
  buildTracePayload,
  exportTrace,
  generateSpanId,
  generateTraceId,
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
  apiKey: z.string().optional().describe(
    "API key / token for the OTLP endpoint (sent as a header value)",
  ),
  apiKeyHeader: z.string().default("x-honeycomb-team").describe(
    "Header name for the API key (e.g. x-honeycomb-team, Authorization)",
  ),
});

const SpanSchema = z.object({
  traceId: z.string(),
  spanId: z.string(),
  name: z.string(),
  status: z.string(),
  durationMs: z.number(),
  attributes: z.record(z.string(), z.any()),
});

export const model = {
  type: "@bixu/opentelemetry",
  version: "2026.03.10.3",
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
      execute: async (args, context) => {
        const extraHeaders: Record<string, string> = {};
        if (context.globalArgs.apiKey) {
          extraHeaders[context.globalArgs.apiKeyHeader] =
            context.globalArgs.apiKey;
        }

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
        const traceId = args.traceId ?? generateTraceId();
        const spanId = generateSpanId();

        const span = buildSpan({
          name: args.name,
          traceId,
          spanId,
          parentSpanId: args.parentSpanId,
          kind: spanKindMap[args.kind],
          startTimeMs: now - args.durationMs,
          endTimeMs: now,
          status: {
            code: statusMap[args.status],
            message: args.statusMessage,
          },
          attributes: parsedAttrs,
        });

        const payload = buildTracePayload(
          [span],
          context.globalArgs.serviceName,
        );

        const result = await exportTrace(
          context.globalArgs.endpoint,
          payload,
          Object.keys(extraHeaders).length > 0 ? extraHeaders : undefined,
        );

        if (!result.ok) {
          throw new Error(
            `OTLP export failed (${result.status}): ${result.body}`,
          );
        }

        context.logger.info("Exported span {name} ({traceId})", {
          name: args.name,
          traceId,
        });

        const handle = await context.writeResource("span", args.name, {
          traceId,
          spanId,
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
