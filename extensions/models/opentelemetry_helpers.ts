/**
 * OpenTelemetry trace helpers using the official OTel JS SDK.
 *
 * Wraps provider setup and span creation for use in swamp extension models.
 */

import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
} from "npm:@opentelemetry/api@1.9.0";
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
} from "npm:@opentelemetry/sdk-trace-base@1.30.1";
import { OTLPTraceExporter } from "npm:@opentelemetry/exporter-trace-otlp-http@0.57.2";
import { Resource } from "npm:@opentelemetry/resources@1.30.1";
import { ATTR_SERVICE_NAME } from "npm:@opentelemetry/semantic-conventions@1.28.0";

export { context, propagation, SpanKind, SpanStatusCode, trace };

let _provider: BasicTracerProvider | null = null;

export interface TracerConfig {
  endpoint: string;
  serviceName: string;
  headers?: Record<string, string>;
}

/** Initialize the global tracer provider. Idempotent — repeated calls are no-ops. */
export function initTracer(config: TracerConfig): void {
  if (_provider) return;

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: config.serviceName,
  });

  const exporter = new OTLPTraceExporter({
    url: config.endpoint.endsWith("/v1/traces")
      ? config.endpoint
      : `${config.endpoint.replace(/\/$/, "")}/v1/traces`,
    headers: config.headers,
  });

  _provider = new BasicTracerProvider({ resource });
  _provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
  _provider.register();
}

/** Get a named tracer (call initTracer first). */
export function getTracer(name: string) {
  return trace.getTracer(name);
}

/** Flush all pending spans. Call before the process exits. */
export async function flushTracer(): Promise<void> {
  if (_provider) {
    await _provider.forceFlush();
  }
}

/** Shut down the provider, flushing all pending spans. */
export async function shutdownTracer(): Promise<void> {
  if (_provider) {
    await _provider.shutdown();
    _provider = null;
  }
}
