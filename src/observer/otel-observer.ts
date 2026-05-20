import type { Tracer, MeterProvider, Context, Attributes, Span, Counter, Histogram } from '@opentelemetry/api'
import { SpanStatusCode, context, trace } from '@opentelemetry/api'
import type { Observer, RunContext, StepContext } from '@noetaris/harness'

/**
 * Options for {@link createOtelObserver}.
 */
export interface OtelObserverOptions {
  /** OTel MeterProvider to use for metrics. If absent, metrics are skipped. */
  meterProvider?: MeterProvider
  /**
   * Explicit parent context for the root span. When provided, the root
   * `agent.run` span is created as a child of the span in this context.
   * When absent, `context.active()` is used (ambient context from OTel middleware).
   */
  parentContext?: Context
  /**
   * Extra attributes merged onto the root `agent.run` span at start time.
   * These are merged with the built-in attributes (`agent.id`, `session.id`);
   * if a key conflicts, the built-in attribute takes precedence.
   */
  attributes?: Attributes
}

// Local shape guard — avoids importing @noetaris/harness-types
type LLMUsageShape = { tokens?: { input?: unknown; output?: unknown } | null }

/**
 * Create an {@link Observer} that records traces and metrics via OpenTelemetry.
 *
 * **Spans produced:**
 * - `agent.run` — root span, one per `agent.run()` invocation.
 * - `agent.step` — child span, one per step execution.
 *
 * **Metrics produced** (requires `options.meterProvider`):
 * - `agent.llm.tokens` (counter) — input/output tokens, tagged by `token.type`.
 * - `agent.step.duration` (histogram, ms) — step duration, tagged by `step.name`.
 *
 * @param tracer - An OTel `Tracer` instance from your SDK.
 * @param options - Optional meter provider, parent context, and extra span attributes.
 *
 * @example
 * ```ts
 * const observer = createOtelObserver(trace.getTracer('my-agent'), {
 *   meterProvider: metrics.getMeterProvider(),
 * })
 * agent.run({}, { llm, observer })
 * ```
 */
export function createOtelObserver(tracer: Tracer, options?: OtelObserverOptions): Observer {
  let rootSpan: Span | undefined
  let stepSpan: Span | undefined

  let counter: Counter | undefined
  let histogram: Histogram | undefined

  if (options?.meterProvider) {
    const meter = options.meterProvider.getMeter('@noetaris/harness-otel', '0.1.0')
    counter = meter.createCounter('agent.llm.tokens')
    histogram = meter.createHistogram('agent.step.duration', { unit: 'ms' })
  }

  return {
    onRunStart(ctx: RunContext): void {
      const builtIn: Attributes = {
        'agent.id': ctx.agentId,
        'session.id': ctx.sessionId,
      }
      const merged: Attributes = { ...options?.attributes, ...builtIn }
      const parentCtx = options?.parentContext ?? context.active()
      rootSpan = tracer.startSpan('agent.run', { attributes: merged }, parentCtx)
    },

    onRunEnd(_ctx: RunContext, _event: { signal: string; durationMs: number }): void {
      if (!rootSpan) return
      rootSpan.end()
      rootSpan = undefined
    },

    onStepStart(ctx: StepContext): void {
      if (!rootSpan) return
      const childCtx = trace.setSpan(context.active(), rootSpan)
      stepSpan = tracer.startSpan('agent.step', { attributes: { 'step.name': ctx.stepName } }, childCtx)
    },

    onStepEnd(ctx: StepContext, event: { durationMs: number }): void {
      if (!stepSpan) return
      const span = stepSpan
      stepSpan = undefined
      histogram?.record(event.durationMs, { 'step.name': ctx.stepName })
      span.end()
    },

    onStepError(ctx: StepContext, event: { error: unknown; durationMs: number }): void {
      if (!stepSpan) return
      const span = stepSpan
      stepSpan = undefined
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(event.error) })
      histogram?.record(event.durationMs, { 'step.name': ctx.stepName })
      span.end()
    },

    onEvent(_ctx: StepContext, type: string, payload: unknown): void {
      if (type === 'llm.response') {
        if (counter) {
          const shaped = payload as LLMUsageShape // as: payload is unknown; guard below validates the shape before use
          if (typeof shaped?.tokens?.input === 'number' && typeof shaped?.tokens?.output === 'number') {
            counter.add(shaped.tokens.input, { 'token.type': 'input' })
            counter.add(shaped.tokens.output, { 'token.type': 'output' })
          }
        }
        return
      }

      const activeSpan = stepSpan ?? rootSpan
      activeSpan?.addEvent(type)
    },
  }
}
