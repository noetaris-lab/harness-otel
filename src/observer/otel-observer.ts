import type { Tracer, MeterProvider, Context, Attributes, Span, Histogram } from '@opentelemetry/api'
import { SpanStatusCode, SpanKind, context, trace } from '@opentelemetry/api'
import type { Observer, RunContext, StepContext } from '@noetaris/harness'

/**
 * Options for {@link createOtelObserver}.
 */
export interface OtelObserverOptions {
  /** OTel MeterProvider to use for metrics. If absent, metrics are skipped. */
  meterProvider?: MeterProvider
  /**
   * Explicit parent context for the root span. When provided, the root
   * "invoke_agent {agentId}" span is created as a child of the span in this context.
   * When absent, `context.active()` is used (ambient context from OTel middleware).
   */
  parentContext?: Context
  /**
   * Extra attributes merged onto the root span at start time.
   * These are merged with the built-in attributes; built-in attributes take precedence.
   */
  attributes?: Attributes
}

// Local shape guards — avoid importing @noetaris/harness-types
type LLMUsageShape = {
  modelId?: unknown
  providerName?: unknown
  stopReason?: unknown
  tokens?: { input?: unknown; output?: unknown } | null
}
type ToolCallShape = { toolName?: unknown; toolCallId?: unknown }
type ToolResultShape = { toolName?: unknown; toolCallId?: unknown; durationMs?: unknown; error?: unknown }

/**
 * Create an {@link Observer} that records traces and metrics via OpenTelemetry
 * following the GenAI semantic conventions.
 *
 * **Spans produced:**
 * - `invoke_agent {agentId}` — root span, one per `agent.run()` invocation.
 * - `harness.step {stepName}` — child span, one per step execution.
 * - `chat {modelId}` — INTERNAL child span, one per `"llm.response"` event.
 * - `execute_tool {toolName}` — INTERNAL child span, one per `"tool.call"` event.
 *
 * **Metrics produced** (requires `options.meterProvider`):
 * - `gen_ai.client.token.usage` (histogram, `{token}`) — input/output tokens per inference call.
 * - `gen_ai.client.operation.duration` (histogram, `s`) — agent invocation duration.
 *
 * @param tracer - An OTel `Tracer` instance from your SDK.
 * @param options - Optional meter provider, parent context, and extra span attributes.
 */
export function createOtelObserver(tracer: Tracer, options?: OtelObserverOptions): Observer {
  let rootSpan: Span | undefined
  let stepSpan: Span | undefined
  const toolSpans = new Map<string, Span>()

  let tokenHistogram: Histogram | undefined
  let durationHistogram: Histogram | undefined

  if (options?.meterProvider) {
    const meter = options.meterProvider.getMeter('@noetaris/harness-otel', '0.1.0')
    tokenHistogram = meter.createHistogram('gen_ai.client.token.usage', { unit: '{token}' })
    durationHistogram = meter.createHistogram('gen_ai.client.operation.duration', { unit: 's' })
  }

  return {
    onRunStart(ctx: RunContext): void {
      const builtIn: Attributes = {
        'gen_ai.agent.id': ctx.agentId,
        'gen_ai.conversation.id': ctx.sessionId,
        'gen_ai.operation.name': 'invoke_agent',
      }
      const merged: Attributes = { ...options?.attributes, ...builtIn }
      const parentCtx = options?.parentContext ?? context.active()
      rootSpan = tracer.startSpan(`invoke_agent ${ctx.agentId}`, { attributes: merged }, parentCtx)
    },

    onRunEnd(_ctx: RunContext, event: { signal: string; durationMs: number }): void {
      if (!rootSpan) return
      rootSpan.end()
      rootSpan = undefined
      durationHistogram?.record(event.durationMs / 1000, { 'gen_ai.operation.name': 'invoke_agent' })
    },

    onStepStart(ctx: StepContext): void {
      if (!rootSpan) return
      const childCtx = trace.setSpan(context.active(), rootSpan)
      stepSpan = tracer.startSpan(`harness.step ${ctx.stepName}`, { attributes: { 'gen_ai.step.name': ctx.stepName } }, childCtx)
    },

    onStepEnd(_ctx: StepContext, _event: { durationMs: number }): void {
      if (!stepSpan) return
      const span = stepSpan
      stepSpan = undefined
      span.end()
    },

    onStepError(_ctx: StepContext, event: { error: unknown; durationMs: number }): void {
      if (!stepSpan) return
      const span = stepSpan
      stepSpan = undefined
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(event.error) })
      span.end()
    },

    onEvent(_ctx: StepContext, type: string, payload: unknown): void {
      if (type === 'llm.response') {
        const shaped = payload as LLMUsageShape // as: payload is unknown; guards below validate the shape before use

        // inference span — requires string modelId and providerName
        const parentSpan = stepSpan ?? rootSpan
        if (parentSpan && typeof shaped?.modelId === 'string' && typeof shaped?.providerName === 'string') {
          const childCtx = trace.setSpan(context.active(), parentSpan)
          const inferenceSpan = tracer.startSpan(`chat ${shaped.modelId}`, { kind: SpanKind.INTERNAL }, childCtx)
          inferenceSpan.setAttribute('gen_ai.request.model', shaped.modelId)
          inferenceSpan.setAttribute('gen_ai.provider.name', shaped.providerName)
          if (typeof shaped?.tokens?.input === 'number' && typeof shaped?.tokens?.output === 'number') {
            inferenceSpan.setAttribute('gen_ai.usage.input_tokens', shaped.tokens.input)
            inferenceSpan.setAttribute('gen_ai.usage.output_tokens', shaped.tokens.output)
          }
          if (typeof shaped?.stopReason === 'string') {
            inferenceSpan.setAttribute('gen_ai.response.finish_reasons', [shaped.stopReason])
          }
          inferenceSpan.end()
        }

        // token histogram — independent of span creation
        if (tokenHistogram && typeof shaped?.tokens?.input === 'number' && typeof shaped?.tokens?.output === 'number') {
          tokenHistogram.record(shaped.tokens.input, { 'gen_ai.token.type': 'input' })
          tokenHistogram.record(shaped.tokens.output, { 'gen_ai.token.type': 'output' })
        }
        return
      }

      if (type === 'tool.call') {
        const shaped = payload as ToolCallShape // as: payload is unknown; guard below validates the shape before use
        if (typeof shaped?.toolName !== 'string' || typeof shaped?.toolCallId !== 'string') return

        const parentSpan = stepSpan ?? rootSpan
        if (!parentSpan) return

        const childCtx = trace.setSpan(context.active(), parentSpan)
        const toolSpan = tracer.startSpan('execute_tool ' + shaped.toolName, {
          kind: SpanKind.INTERNAL,
          attributes: {
            'gen_ai.tool.name': shaped.toolName,
            'gen_ai.operation.name': 'execute_tool',
          },
        }, childCtx)
        toolSpans.set(shaped.toolCallId, toolSpan)
        return
      }

      if (type === 'tool.result') {
        const shaped = payload as ToolResultShape // as: payload is unknown; guard below validates the shape before use
        if (typeof shaped?.toolCallId !== 'string') return

        const toolSpan = toolSpans.get(shaped.toolCallId)
        if (!toolSpan) return

        toolSpans.delete(shaped.toolCallId)

        if (shaped.error !== undefined) {
          toolSpan.setStatus({ code: SpanStatusCode.ERROR, message: String(shaped.error) })
        }
        toolSpan.end()
        return
      }

      const activeSpan = stepSpan ?? rootSpan
      activeSpan?.addEvent(type)
    },
  }
}
