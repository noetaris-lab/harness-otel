import type { Tracer, MeterProvider, Context, Attributes, Span, Histogram } from '@opentelemetry/api'
import { SpanStatusCode, SpanKind, context, trace } from '@opentelemetry/api'
import type { Observer, RunContext, StepContext } from '@noetaris/harness'

/**
 * Options for {@link createOtelObserver}.
 */
export interface OtelObserverOptions {
  /** OTel MeterProvider for metrics. If absent, metrics are skipped. */
  meterProvider?: MeterProvider
  /**
   * Explicit parent context for the root span. When provided, the root span is
   * created as a child of this context. When absent, `context.active()` is used.
   */
  parentContext?: Context
  /** Extra attributes merged onto the root span; built-in attributes win on conflict. */
  attributes?: Attributes
  /**
   * When `true`, serialises `messages` from `"llm.request"` into a
   * `gen_ai.content.prompt` span event. Default: `false`.
   */
  captureInputs?: boolean
  /**
   * When `true`, serialises `output` from `"llm.response"` into a
   * `gen_ai.content.completion` span event. Default: `false`.
   */
  captureOutputs?: boolean
  /**
   * When `true`, serialises `input` / `result` from `"tool.call"` / `"tool.result"`
   * into `gen_ai.tool.input` / `gen_ai.tool.output` span events. Default: `false`.
   */
  captureToolIO?: boolean
  /**
   * Maximum characters for any serialised content-capture payload.
   * Payloads longer than this are truncated with a `…` suffix. Default: `8192`.
   */
  maxContentLength?: number
}

// Local shape guards — avoid importing @noetaris/harness-types
type LLMRequestShape  = { modelId?: unknown; providerName?: unknown; messages?: unknown }
type LLMResponseShape = { modelId?: unknown; providerName?: unknown; stopReason?: unknown; tokens?: { input?: unknown; output?: unknown } | null; output?: unknown }
type ToolCallShape    = { toolName?: unknown; toolCallId?: unknown; input?: unknown }
type ToolResultShape  = { toolCallId?: unknown; error?: unknown; result?: unknown }

/**
 * Create an {@link Observer} that records traces and metrics via OpenTelemetry
 * following the GenAI semantic conventions.
 *
 * **Spans produced:**
 * - `invoke_agent {agentId}` — root span, one per `agent.run()`.
 * - `harness.step {stepName}` — child span, one per step.
 * - `chat {modelId}` — INTERNAL child span, opened on `"llm.request"`, closed on `"llm.response"`.
 * - `execute_tool {toolName}` — INTERNAL child span, one per `"tool.call"`.
 *
 * **Metrics produced** (requires `options.meterProvider`):
 * - `gen_ai.client.token.usage` (histogram, `{token}`) — input/output tokens per inference call.
 * - `gen_ai.client.operation.duration` (histogram, `s`) — agent invocation duration.
 */
export function createOtelObserver(tracer: Tracer, options?: OtelObserverOptions): Observer {
  let rootSpan: Span | undefined
  let stepSpan: Span | undefined
  const toolSpans      = new Map<string, Span>()
  const inferenceSpans = new Map<number, Span>()
  let llmCallCounter   = 0

  let tokenHistogram:    Histogram | undefined
  let durationHistogram: Histogram | undefined

  const maxLen = options?.maxContentLength ?? 8192

  function truncate(s: string): string {
    return s.length > maxLen ? s.slice(0, maxLen) + '…' : s
  }

  if (options?.meterProvider) {
    const meter = options.meterProvider.getMeter('@noetaris/harness-otel', '0.1.0')
    tokenHistogram    = meter.createHistogram('gen_ai.client.token.usage',        { unit: '{token}' })
    durationHistogram = meter.createHistogram('gen_ai.client.operation.duration', { unit: 's' })
  }

  return {
    onRunStart(ctx: RunContext): void {
      const builtIn: Attributes = {
        'gen_ai.agent.id':        ctx.agentId,
        'gen_ai.conversation.id': ctx.sessionId,
        'gen_ai.operation.name':  'invoke_agent',
      }
      const merged    = { ...options?.attributes, ...builtIn }
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
      llmCallCounter = 0  // unconditional reset — even when no root span is active
      if (!rootSpan) return
      const childCtx = trace.setSpan(context.active(), rootSpan)
      stepSpan = tracer.startSpan(
        `harness.step ${ctx.stepName}`,
        { attributes: { 'gen_ai.step.name': ctx.stepName } },
        childCtx,
      )
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
      // ── "llm.request" — open inference span ──────────────────────────────────
      if (type === 'llm.request') {
        const shaped = payload as LLMRequestShape
        if (typeof shaped?.modelId !== 'string' || typeof shaped?.providerName !== 'string') return

        const parentSpan = stepSpan ?? rootSpan
        if (!parentSpan) return

        const childCtx       = trace.setSpan(context.active(), parentSpan)
        const inferenceSpan  = tracer.startSpan(`chat ${shaped.modelId}`, { kind: SpanKind.INTERNAL }, childCtx)
        llmCallCounter++
        inferenceSpans.set(llmCallCounter, inferenceSpan)

        if (options?.captureInputs && shaped.messages !== undefined) {
          try {
            inferenceSpan.addEvent('gen_ai.content.prompt', { 'gen_ai.prompt': truncate(JSON.stringify(shaped.messages)) })
          } catch { /* non-serialisable payload — skip event */ }
        }
        return
      }

      // ── "llm.response" — close inference span ────────────────────────────────
      if (type === 'llm.response') {
        const shaped = payload as LLMResponseShape

        // token histogram — independent of span logic
        if (tokenHistogram && typeof shaped?.tokens?.input === 'number' && typeof shaped?.tokens?.output === 'number') {
          tokenHistogram.record(shaped.tokens.input,  { 'gen_ai.token.type': 'input' })
          tokenHistogram.record(shaped.tokens.output, { 'gen_ai.token.type': 'output' })
        }

        if (typeof shaped?.modelId !== 'string' || typeof shaped?.providerName !== 'string') return

        // LIFO lookup: retrieve the most-recently-opened inference span
        let inferenceSpan: Span | undefined = inferenceSpans.get(llmCallCounter)
        if (inferenceSpan) {
          inferenceSpans.delete(llmCallCounter)
          llmCallCounter--
        } else {
          // legacy fallback — adapter did not emit "llm.request"
          const parentSpan = stepSpan ?? rootSpan
          if (!parentSpan) return
          const childCtx = trace.setSpan(context.active(), parentSpan)
          inferenceSpan = tracer.startSpan(`chat ${shaped.modelId}`, { kind: SpanKind.INTERNAL }, childCtx)
        }

        inferenceSpan.setAttribute('gen_ai.request.model',  shaped.modelId)
        inferenceSpan.setAttribute('gen_ai.provider.name',  shaped.providerName)
        if (typeof shaped?.tokens?.input === 'number' && typeof shaped?.tokens?.output === 'number') {
          inferenceSpan.setAttribute('gen_ai.usage.input_tokens',  shaped.tokens.input)
          inferenceSpan.setAttribute('gen_ai.usage.output_tokens', shaped.tokens.output)
        }
        if (typeof shaped?.stopReason === 'string') {
          inferenceSpan.setAttribute('gen_ai.response.finish_reasons', [shaped.stopReason])
        }

        if (options?.captureOutputs && shaped.output !== undefined) {
          try {
            inferenceSpan.addEvent('gen_ai.content.completion', { 'gen_ai.completion': truncate(JSON.stringify(shaped.output)) })
          } catch { /* non-serialisable payload — skip event */ }
        }

        inferenceSpan.end()
        return
      }

      // ── "tool.call" — open tool span ─────────────────────────────────────────
      if (type === 'tool.call') {
        const shaped = payload as ToolCallShape
        if (typeof shaped?.toolName !== 'string' || typeof shaped?.toolCallId !== 'string') return

        const parentSpan = stepSpan ?? rootSpan
        if (!parentSpan) return

        const childCtx = trace.setSpan(context.active(), parentSpan)
        const toolSpan = tracer.startSpan('execute_tool ' + shaped.toolName, {
          kind: SpanKind.INTERNAL,
          attributes: { 'gen_ai.tool.name': shaped.toolName, 'gen_ai.operation.name': 'execute_tool' },
        }, childCtx)
        toolSpans.set(shaped.toolCallId, toolSpan)

        if (options?.captureToolIO && shaped.input !== undefined) {
          try {
            toolSpan.addEvent('gen_ai.tool.input', { 'gen_ai.tool.input': truncate(JSON.stringify(shaped.input)) })
          } catch { /* non-serialisable payload — skip event */ }
        }
        return
      }

      // ── "tool.result" — close tool span ──────────────────────────────────────
      if (type === 'tool.result') {
        const shaped = payload as ToolResultShape
        if (typeof shaped?.toolCallId !== 'string') return

        const toolSpan = toolSpans.get(shaped.toolCallId)
        if (!toolSpan) return
        toolSpans.delete(shaped.toolCallId)

        if (shaped.error !== undefined) {
          toolSpan.setStatus({ code: SpanStatusCode.ERROR, message: String(shaped.error) })
        }

        if (options?.captureToolIO && shaped.result !== undefined) {
          try {
            toolSpan.addEvent('gen_ai.tool.output', { 'gen_ai.tool.output': truncate(JSON.stringify(shaped.result)) })
          } catch { /* non-serialisable payload — skip event */ }
        }

        toolSpan.end()
        return
      }

      // ── non-reserved event fallthrough ────────────────────────────────────────
      const activeSpan = stepSpan ?? rootSpan
      activeSpan?.addEvent(type)
    },
  }
}
