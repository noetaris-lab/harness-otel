import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  type Span,
  type Tracer,
  type Context,
  type MeterProvider,
  SpanStatusCode,
  SpanKind,
  context,
  trace,
} from '@opentelemetry/api'
import { createOtelObserver } from './otel-observer.js'

// ---- Stub helpers ----

function makeMockSpan(): Span {
  return {
    end: vi.fn(),
    setStatus: vi.fn(),
    addEvent: vi.fn(),
    setAttribute: vi.fn(),
    setAttributes: vi.fn(),
    recordException: vi.fn(),
    updateName: vi.fn(),
    isRecording: vi.fn().mockReturnValue(true),
    spanContext: vi.fn().mockReturnValue({}),
  } as unknown as Span // as: partial stub — only the methods under test are implemented
}

function makeMockTracer(overrides: { startSpan?: ReturnType<typeof vi.fn> } = {}): Tracer {
  const startSpan = overrides.startSpan ?? vi.fn().mockReturnValue(makeMockSpan())
  return { startSpan } as unknown as Tracer // as: partial stub — only startSpan is needed
}

function makeMockHistogram() {
  return { record: vi.fn() }
}

function makeMockMeterProvider(overrides: { tokenHistogram?: ReturnType<typeof makeMockHistogram>; durationHistogram?: ReturnType<typeof makeMockHistogram> } = {}) {
  const tokenHistogram = overrides.tokenHistogram ?? makeMockHistogram()
  const durationHistogram = overrides.durationHistogram ?? makeMockHistogram()
  const createHistogram = vi.fn().mockImplementation((name: string) => {
    if (name === 'gen_ai.client.token.usage') return tokenHistogram
    if (name === 'gen_ai.client.operation.duration') return durationHistogram
    return makeMockHistogram()
  })
  const meter = { createHistogram }
  const getMeter = vi.fn().mockReturnValue(meter)
  return { getMeter, _meter: meter, _tokenHistogram: tokenHistogram, _durationHistogram: durationHistogram }
}

function makeRunContext(overrides: { agentId?: string; sessionId?: string } = {}) {
  return { agentId: overrides.agentId ?? 'agent-1', sessionId: overrides.sessionId ?? 'sess-1', runId: 'run-1' }
}

function makeStepContext(overrides: { stepName?: string } = {}) {
  return { agentId: 'agent-1', sessionId: 'sess-1', stepName: overrides.stepName ?? 'step-1' }
}

// ---- Tests ----

describe('createOtelObserver', () => {

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  // ---- Group 1: Root span lifecycle (onRunStart) ----

  describe('onRunStart', () => {

    it('creates "invoke_agent {agentId}" span with built-in attributes using context.active() when no options', () => {
      // arrange
      const mockSpan = makeMockSpan()
      const mockTracer = makeMockTracer({ startSpan: vi.fn().mockReturnValue(mockSpan) })
      const activeCtx = {} as Context // as: sentinel for identity check
      vi.spyOn(context, 'active').mockReturnValue(activeCtx)
      const observer = createOtelObserver(mockTracer)
      const ctx = makeRunContext({ agentId: 'agent-1', sessionId: 'sess-abc' })

      // act
      observer.onRunStart!(ctx)

      // assert
      expect(mockTracer.startSpan).toHaveBeenCalledWith(
        'invoke_agent agent-1',
        { attributes: { 'gen_ai.agent.id': 'agent-1', 'gen_ai.conversation.id': 'sess-abc', 'gen_ai.operation.name': 'invoke_agent' } },
        activeCtx,
      )
    })

    it('uses explicit options.parentContext instead of context.active()', () => {
      // arrange
      const mockTracer = makeMockTracer()
      const explicitCtx = {} as Context // as: sentinel for identity check
      const observer = createOtelObserver(mockTracer, { parentContext: explicitCtx })
      const ctx = makeRunContext({ agentId: 'agent-2', sessionId: 'sess-2' })
      const activeCtx = { _isActiveCtx: 1 } as unknown as Context // distinct from explicitCtx so deep-equality check works
      vi.spyOn(context, 'active').mockReturnValue(activeCtx)

      // act
      observer.onRunStart!(ctx)

      // assert
      expect(mockTracer.startSpan).toHaveBeenCalledWith(expect.any(String), expect.any(Object), explicitCtx)
      expect(mockTracer.startSpan).not.toHaveBeenCalledWith(expect.any(String), expect.any(Object), activeCtx)
    })

    it('merges options.attributes with built-in attrs; built-in attrs win on conflict', () => {
      // arrange
      const mockTracer = makeMockTracer()
      const observer = createOtelObserver(mockTracer, { attributes: { 'service.version': '1.2.3', 'gen_ai.agent.id': 'SHOULD_BE_OVERRIDDEN' } })
      const ctx = makeRunContext({ agentId: 'real-agent', sessionId: 'sess-x' })

      // act
      observer.onRunStart!(ctx)

      // assert
      expect(mockTracer.startSpan).toHaveBeenCalledWith(
        'invoke_agent real-agent',
        expect.objectContaining({ attributes: { 'service.version': '1.2.3', 'gen_ai.agent.id': 'real-agent', 'gen_ai.conversation.id': 'sess-x', 'gen_ai.operation.name': 'invoke_agent' } }),
        expect.anything(),
      )
    })

    it('second onRunStart without intervening onRunEnd overwrites root span reference; old span is leaked', () => {
      // arrange
      const span1 = makeMockSpan()
      const span2 = makeMockSpan()
      const mockTracer = makeMockTracer({ startSpan: vi.fn().mockReturnValueOnce(span1).mockReturnValueOnce(span2) })
      const observer = createOtelObserver(mockTracer)
      observer.onRunStart!(makeRunContext({ agentId: 'a', sessionId: 's' }))

      // act
      observer.onRunStart!(makeRunContext({ agentId: 'a2', sessionId: 's2' }))

      // assert
      expect(mockTracer.startSpan).toHaveBeenCalledTimes(2)
      expect(span1.end).not.toHaveBeenCalled()
      observer.onRunEnd!(makeRunContext({ agentId: 'a2', sessionId: 's2' }), { signal: 'done', durationMs: 10 })
      expect(span2.end).toHaveBeenCalledOnce()
      expect(span1.end).not.toHaveBeenCalled()
    })

    it('Observer is safely reusable across sequential runs after onRunEnd', () => {
      // arrange
      const span1 = makeMockSpan()
      const span2 = makeMockSpan()
      const mockTracer = makeMockTracer({ startSpan: vi.fn().mockReturnValueOnce(span1).mockReturnValueOnce(span2) })
      const observer = createOtelObserver(mockTracer)
      const ctx1 = makeRunContext({ agentId: 'a', sessionId: 's1' })
      const ctx2 = makeRunContext({ agentId: 'a', sessionId: 's2' })

      // act
      observer.onRunStart!(ctx1)
      observer.onRunEnd!(ctx1, { signal: 'done', durationMs: 100 })
      observer.onRunStart!(ctx2)
      observer.onRunEnd!(ctx2, { signal: 'done', durationMs: 200 })

      // assert
      expect(mockTracer.startSpan).toHaveBeenCalledTimes(2)
      expect(span1.end).toHaveBeenCalledOnce()
      expect(span2.end).toHaveBeenCalledOnce()
    })

  })

  // ---- Group 2: Step span lifecycle (onStepStart / onStepEnd / onStepError) ----

  describe('onStepStart', () => {

    it('creates "harness.step {stepName}" span as child of root span and resets inference counter to 0', () => {
      // arrange
      const rootSpan = makeMockSpan()
      const inferenceSpanPreStep = makeMockSpan()
      const stepSpan = makeMockSpan()
      const spanCtx = {} as Context // as: sentinel returned by trace.setSpan(_, rootSpan)
      const mockTracer = makeMockTracer({ startSpan: vi.fn().mockReturnValueOnce(rootSpan).mockReturnValueOnce(inferenceSpanPreStep).mockReturnValueOnce(stepSpan).mockReturnValue(makeMockSpan()) })
      vi.spyOn(trace, 'setSpan').mockImplementation((_ctx, span) => span === rootSpan ? spanCtx : ({} as Context))
      const observer = createOtelObserver(mockTracer)
      observer.onRunStart!(makeRunContext({ agentId: 'a', sessionId: 's' }))
      // advance counter to 1 before step start
      observer.onEvent!(makeStepContext(), 'llm.request', { modelId: 'gpt', providerName: 'openai' })

      // act
      observer.onStepStart!(makeStepContext({ stepName: 'call-llm' }))

      // assert — 3rd startSpan call is the step span
      expect(mockTracer.startSpan).toHaveBeenNthCalledWith(3, 'harness.step call-llm', { attributes: { 'gen_ai.step.name': 'call-llm' } }, spanCtx)
      // counter was reset to 0 — next llm.request becomes 4th startSpan call
      observer.onEvent!(makeStepContext(), 'llm.request', { modelId: 'gpt', providerName: 'openai' })
      expect(mockTracer.startSpan).toHaveBeenCalledTimes(4)
    })

    it('does not create step span when no root span is active; counter still reset to 0', () => {
      // arrange
      const mockTracer = makeMockTracer()
      const observer = createOtelObserver(mockTracer)
      // pre-load counter via a prior run
      observer.onRunStart!(makeRunContext({ agentId: 'a', sessionId: 's' })) // 1st startSpan
      observer.onEvent!(makeStepContext(), 'llm.request', { modelId: 'm', providerName: 'p' }) // 2nd startSpan; counter → 1
      observer.onRunEnd!(makeRunContext({ agentId: 'a', sessionId: 's' }), { signal: 'done', durationMs: 10 }) // root span cleared

      // act
      observer.onStepStart!(makeStepContext({ stepName: 'step-2' }))

      // assert — only root and inference from prior run; no step span
      expect(mockTracer.startSpan).toHaveBeenCalledTimes(2)
      // counter reset to 0 — llm.request without root span is a no-op, startSpan count stays 2
      observer.onEvent!(makeStepContext(), 'llm.request', { modelId: 'm', providerName: 'p' })
      expect(mockTracer.startSpan).toHaveBeenCalledTimes(2)
    })

    it('onStepEnd ends step span and clears reference', () => {
      // arrange
      const rootSpan = makeMockSpan()
      const stepSpan = makeMockSpan()
      const mockTracer = makeMockTracer({ startSpan: vi.fn().mockReturnValueOnce(rootSpan).mockReturnValueOnce(stepSpan) })
      const observer = createOtelObserver(mockTracer)
      observer.onRunStart!(makeRunContext())
      observer.onStepStart!(makeStepContext({ stepName: 'step-1' }))

      // act
      observer.onStepEnd!(makeStepContext(), { durationMs: 50 })

      // assert
      expect(stepSpan.end).toHaveBeenCalledOnce()
      expect(rootSpan.end).not.toHaveBeenCalled()
    })

    it('onStepEnd is a no-op when no step span is active', () => {
      // arrange
      const mockTracer = makeMockTracer()
      const observer = createOtelObserver(mockTracer)

      // act / assert
      expect(() => observer.onStepEnd!(makeStepContext(), { durationMs: 0 })).not.toThrow()
    })

    it('onStepError sets ERROR status, ends step span, and clears reference', () => {
      // arrange
      const rootSpan = makeMockSpan()
      const stepSpan = makeMockSpan()
      const mockTracer = makeMockTracer({ startSpan: vi.fn().mockReturnValueOnce(rootSpan).mockReturnValueOnce(stepSpan) })
      const observer = createOtelObserver(mockTracer)
      observer.onRunStart!(makeRunContext())
      observer.onStepStart!(makeStepContext({ stepName: 'step-err' }))
      const err = new Error('step failed')

      // act
      observer.onStepError!(makeStepContext(), { error: err, durationMs: 10 })

      // assert
      expect(stepSpan.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR, message: 'Error: step failed' })
      expect(stepSpan.end).toHaveBeenCalledOnce()
      expect(rootSpan.end).not.toHaveBeenCalled()
    })

    it('onStepError is a no-op when no step span is active', () => {
      // arrange
      const mockTracer = makeMockTracer()
      const observer = createOtelObserver(mockTracer)

      // act / assert
      expect(() => observer.onStepError!(makeStepContext(), { error: new Error('e'), durationMs: 0 })).not.toThrow()
    })

  })

  // ---- Group 3: Run end and duration metric (onRunEnd) ----

  describe('onRunEnd', () => {

    it('ends root span and records duration histogram in seconds', () => {
      // arrange
      const rootSpan = makeMockSpan()
      const mockTracer = makeMockTracer({ startSpan: vi.fn().mockReturnValue(rootSpan) })
      const durationHistogram = makeMockHistogram()
      const mp = makeMockMeterProvider({ durationHistogram })
      const observer = createOtelObserver(mockTracer, { meterProvider: mp as unknown as MeterProvider })
      observer.onRunStart!(makeRunContext({ agentId: 'a', sessionId: 's' }))

      // act
      observer.onRunEnd!(makeRunContext({ agentId: 'a', sessionId: 's' }), { signal: 'done', durationMs: 2500 })

      // assert
      expect(rootSpan.end).toHaveBeenCalledOnce()
      expect(durationHistogram.record).toHaveBeenCalledWith(2.5, { 'gen_ai.operation.name': 'invoke_agent' })
    })

    it('onRunEnd with no root span is a no-op and records no histogram', () => {
      // arrange
      const durationHistogram = makeMockHistogram()
      const mp = makeMockMeterProvider({ durationHistogram })
      const mockTracer = makeMockTracer()
      const observer = createOtelObserver(mockTracer, { meterProvider: mp as unknown as MeterProvider })

      // act / assert
      expect(() => observer.onRunEnd!(makeRunContext(), { signal: 'done', durationMs: 100 })).not.toThrow()
      expect(durationHistogram.record).not.toHaveBeenCalled()
    })

    it('onRunEnd without meterProvider ends span but does not record histogram', () => {
      // arrange
      const rootSpan = makeMockSpan()
      const mockTracer = makeMockTracer({ startSpan: vi.fn().mockReturnValue(rootSpan) })
      const observer = createOtelObserver(mockTracer)
      observer.onRunStart!(makeRunContext())

      // act
      observer.onRunEnd!(makeRunContext(), { signal: 'done', durationMs: 500 })

      // assert
      expect(rootSpan.end).toHaveBeenCalledOnce()
    })

  })

  // ---- Group 4: Token histogram ("llm.response" metrics) ----

  describe('onEvent — token histogram', () => {

    it('records input and output token histogram when tokens present', () => {
      // arrange
      const tokenHistogram = makeMockHistogram()
      const mp = makeMockMeterProvider({ tokenHistogram })
      const mockTracer = makeMockTracer()
      const observer = createOtelObserver(mockTracer, { meterProvider: mp as unknown as MeterProvider })
      const ctx = makeStepContext()

      // act
      observer.onEvent!(ctx, 'llm.response', { modelId: 'gpt-4o', providerName: 'openai', tokens: { input: 120, output: 45 } })

      // assert
      expect(tokenHistogram.record).toHaveBeenCalledWith(120, { 'gen_ai.token.type': 'input' })
      expect(tokenHistogram.record).toHaveBeenCalledWith(45, { 'gen_ai.token.type': 'output' })
      expect(tokenHistogram.record).toHaveBeenCalledTimes(2)
    })

    it('no histogram call when meterProvider is absent', () => {
      // arrange
      const mockTracer = makeMockTracer()
      const observer = createOtelObserver(mockTracer)
      const ctx = makeStepContext()

      // act / assert
      expect(() => observer.onEvent!(ctx, 'llm.response', { modelId: 'gpt-4o', providerName: 'openai', tokens: { input: 50, output: 20 } })).not.toThrow()
    })

    it('no histogram call when tokens missing or non-numeric', () => {
      // arrange
      const tokenHistogram = makeMockHistogram()
      const mp = makeMockMeterProvider({ tokenHistogram })
      const mockTracer = makeMockTracer()
      const observer = createOtelObserver(mockTracer, { meterProvider: mp as unknown as MeterProvider })

      // act
      observer.onEvent!(makeStepContext(), 'llm.response', { modelId: 'm', providerName: 'p' })
      observer.onEvent!(makeStepContext(), 'llm.response', { modelId: 'm', providerName: 'p', tokens: { input: 'many', output: 'few' } })

      // assert
      expect(tokenHistogram.record).not.toHaveBeenCalled()
    })

  })

  // ---- Group 5: Inference span timing ("llm.request" open) ----

  describe('onEvent — "llm.request" opens inference span', () => {

    it('opens INTERNAL inference span as child of step span; counter incremented; span NOT ended', () => {
      // arrange
      const rootSpan = makeMockSpan()
      const stepSpan = makeMockSpan()
      const inferenceSpan = makeMockSpan()
      const stepCtx = {} as Context // as: sentinel from trace.setSpan(_, stepSpan)
      const mockTracer = makeMockTracer({ startSpan: vi.fn().mockReturnValueOnce(rootSpan).mockReturnValueOnce(stepSpan).mockReturnValueOnce(inferenceSpan) })
      vi.spyOn(trace, 'setSpan').mockImplementation((_ctx, span) => span === stepSpan ? stepCtx : ({} as Context))
      const observer = createOtelObserver(mockTracer)
      observer.onRunStart!(makeRunContext())
      observer.onStepStart!(makeStepContext({ stepName: 'step-1' }))

      // act
      observer.onEvent!(makeStepContext(), 'llm.request', { modelId: 'gpt-4o', providerName: 'openai' })

      // assert
      expect(mockTracer.startSpan).toHaveBeenNthCalledWith(3, 'chat gpt-4o', expect.objectContaining({ kind: SpanKind.INTERNAL }), stepCtx)
      expect(inferenceSpan.end).not.toHaveBeenCalled()
    })

    it('inference span parented to root span when no step span is active', () => {
      // arrange
      const rootSpan = makeMockSpan()
      const inferenceSpan = makeMockSpan()
      const rootCtx = {} as Context // as: sentinel from trace.setSpan(_, rootSpan)
      const mockTracer = makeMockTracer({ startSpan: vi.fn().mockReturnValueOnce(rootSpan).mockReturnValueOnce(inferenceSpan) })
      vi.spyOn(trace, 'setSpan').mockImplementation((_ctx, span) => span === rootSpan ? rootCtx : ({} as Context))
      const observer = createOtelObserver(mockTracer)
      observer.onRunStart!(makeRunContext())

      // act
      observer.onEvent!(makeStepContext(), 'llm.request', { modelId: 'claude-3', providerName: 'anthropic' })

      // assert
      expect(mockTracer.startSpan).toHaveBeenNthCalledWith(2, 'chat claude-3', expect.any(Object), rootCtx)
      expect(inferenceSpan.end).not.toHaveBeenCalled()
    })

    it('no inference span created when neither root nor step span is active', () => {
      // arrange
      const mockTracer = makeMockTracer()
      const observer = createOtelObserver(mockTracer)

      // act
      observer.onEvent!(makeStepContext(), 'llm.request', { modelId: 'gpt-4o', providerName: 'openai' })

      // assert
      expect(mockTracer.startSpan).not.toHaveBeenCalled()
    })

    it('"llm.request" with non-string modelId — no inference span created', () => {
      // arrange
      const rootSpan = makeMockSpan()
      const mockTracer = makeMockTracer({ startSpan: vi.fn().mockReturnValue(rootSpan) })
      const observer = createOtelObserver(mockTracer)
      observer.onRunStart!(makeRunContext())

      // act
      observer.onEvent!(makeStepContext(), 'llm.request', { modelId: 42, providerName: 'openai' })

      // assert
      expect(mockTracer.startSpan).toHaveBeenCalledTimes(1)
    })

    it('"llm.request" with non-string providerName — no inference span created', () => {
      // arrange
      const rootSpan = makeMockSpan()
      const mockTracer = makeMockTracer({ startSpan: vi.fn().mockReturnValue(rootSpan) })
      const observer = createOtelObserver(mockTracer)
      observer.onRunStart!(makeRunContext())

      // act
      observer.onEvent!(makeStepContext(), 'llm.request', { modelId: 'gpt-4o', providerName: null })

      // assert
      expect(mockTracer.startSpan).toHaveBeenCalledTimes(1)
    })

  })

  // ---- Group 6: Inference input content capture (captureInputs) ----

  describe('onEvent — captureInputs', () => {

    it('captureInputs: true records "gen_ai.content.prompt" on inference span', () => {
      // arrange
      const rootSpan = makeMockSpan()
      const stepSpan = makeMockSpan()
      const inferenceSpan = makeMockSpan()
      const mockTracer = makeMockTracer({ startSpan: vi.fn().mockReturnValueOnce(rootSpan).mockReturnValueOnce(stepSpan).mockReturnValueOnce(inferenceSpan) })
      const observer = createOtelObserver(mockTracer, { captureInputs: true })
      observer.onRunStart!(makeRunContext())
      observer.onStepStart!(makeStepContext())
      const messages = [{ role: 'user', content: 'hello' }]

      // act
      observer.onEvent!(makeStepContext(), 'llm.request', { modelId: 'gpt-4o', providerName: 'openai', messages })

      // assert
      expect(inferenceSpan.addEvent).toHaveBeenCalledWith('gen_ai.content.prompt', { 'gen_ai.prompt': JSON.stringify(messages) })
    })

    it('captureInputs: false (default) — no addEvent called on inference span', () => {
      // arrange
      const rootSpan = makeMockSpan()
      const stepSpan = makeMockSpan()
      const inferenceSpan = makeMockSpan()
      const mockTracer = makeMockTracer({ startSpan: vi.fn().mockReturnValueOnce(rootSpan).mockReturnValueOnce(stepSpan).mockReturnValueOnce(inferenceSpan) })
      const observer = createOtelObserver(mockTracer)
      observer.onRunStart!(makeRunContext())
      observer.onStepStart!(makeStepContext())

      // act
      observer.onEvent!(makeStepContext(), 'llm.request', { modelId: 'gpt-4o', providerName: 'openai', messages: [{ role: 'user', content: 'secret' }] })

      // assert
      expect(inferenceSpan.addEvent).not.toHaveBeenCalled()
    })

    it('captureInputs: true with messages absent — no span event', () => {
      // arrange
      const rootSpan = makeMockSpan()
      const stepSpan = makeMockSpan()
      const inferenceSpan = makeMockSpan()
      const mockTracer = makeMockTracer({ startSpan: vi.fn().mockReturnValueOnce(rootSpan).mockReturnValueOnce(stepSpan).mockReturnValueOnce(inferenceSpan) })
      const observer = createOtelObserver(mockTracer, { captureInputs: true })
      observer.onRunStart!(makeRunContext())
      observer.onStepStart!(makeStepContext())

      // act
      observer.onEvent!(makeStepContext(), 'llm.request', { modelId: 'gpt-4o', providerName: 'openai' })

      // assert
      expect(inferenceSpan.addEvent).not.toHaveBeenCalled()
    })

  })

  // ---- Group 7: Inference span close ("llm.response") ----

  describe('onEvent — "llm.response" closes inference span', () => {

    it('normal path: retrieves inference span at counter, sets attributes, ends span, decrements counter', () => {
      // arrange
      const rootSpan = makeMockSpan()
      const stepSpan = makeMockSpan()
      const inferenceSpan = makeMockSpan()
      const mockTracer = makeMockTracer({ startSpan: vi.fn().mockReturnValueOnce(rootSpan).mockReturnValueOnce(stepSpan).mockReturnValueOnce(inferenceSpan) })
      const tokenHistogram = makeMockHistogram()
      const mp = makeMockMeterProvider({ tokenHistogram })
      const observer = createOtelObserver(mockTracer, { meterProvider: mp as unknown as MeterProvider })
      observer.onRunStart!(makeRunContext())
      observer.onStepStart!(makeStepContext())
      observer.onEvent!(makeStepContext(), 'llm.request', { modelId: 'claude-3-5-haiku', providerName: 'anthropic' })

      // act
      observer.onEvent!(makeStepContext(), 'llm.response', { modelId: 'claude-3-5-haiku', providerName: 'anthropic', tokens: { input: 80, output: 30 }, stopReason: 'end_turn' })

      // assert
      expect(inferenceSpan.setAttribute).toHaveBeenCalledWith('gen_ai.request.model', 'claude-3-5-haiku')
      expect(inferenceSpan.setAttribute).toHaveBeenCalledWith('gen_ai.provider.name', 'anthropic')
      expect(inferenceSpan.setAttribute).toHaveBeenCalledWith('gen_ai.usage.input_tokens', 80)
      expect(inferenceSpan.setAttribute).toHaveBeenCalledWith('gen_ai.usage.output_tokens', 30)
      expect(inferenceSpan.setAttribute).toHaveBeenCalledWith('gen_ai.response.finish_reasons', ['end_turn'])
      expect(inferenceSpan.end).toHaveBeenCalledOnce()
      expect(tokenHistogram.record).toHaveBeenCalledWith(80, { 'gen_ai.token.type': 'input' })
      expect(tokenHistogram.record).toHaveBeenCalledWith(30, { 'gen_ai.token.type': 'output' })
    })

    it('legacy fallback: creates and immediately ends span when no matching inference span', () => {
      // arrange
      const rootSpan = makeMockSpan()
      const stepSpan = makeMockSpan()
      const fallbackSpan = makeMockSpan()
      const mockTracer = makeMockTracer({ startSpan: vi.fn().mockReturnValueOnce(rootSpan).mockReturnValueOnce(stepSpan).mockReturnValueOnce(fallbackSpan) })
      const observer = createOtelObserver(mockTracer)
      observer.onRunStart!(makeRunContext())
      observer.onStepStart!(makeStepContext())
      // no "llm.request" emitted — counter stays at 0

      // act
      observer.onEvent!(makeStepContext(), 'llm.response', { modelId: 'gpt-4o', providerName: 'openai', tokens: { input: 10, output: 5 } })

      // assert
      expect(mockTracer.startSpan).toHaveBeenCalledTimes(3)
      expect(fallbackSpan.end).toHaveBeenCalledOnce()
      expect(fallbackSpan.setAttribute).toHaveBeenCalledWith('gen_ai.request.model', 'gpt-4o')
    })

    it('legacy fallback with no root or step span — no span created; tokens still recorded', () => {
      // arrange
      const tokenHistogram = makeMockHistogram()
      const mp = makeMockMeterProvider({ tokenHistogram })
      const mockTracer = makeMockTracer()
      const observer = createOtelObserver(mockTracer, { meterProvider: mp as unknown as MeterProvider })

      // act
      observer.onEvent!(makeStepContext(), 'llm.response', { modelId: 'gpt-4o', providerName: 'openai', tokens: { input: 10, output: 5 } })

      // assert
      expect(mockTracer.startSpan).not.toHaveBeenCalled()
      expect(tokenHistogram.record).toHaveBeenCalledWith(10, { 'gen_ai.token.type': 'input' })
      expect(tokenHistogram.record).toHaveBeenCalledWith(5, { 'gen_ai.token.type': 'output' })
    })

    it('"llm.response" never routes payload to span.addEvent on step or root span', () => {
      // arrange
      const rootSpan = makeMockSpan()
      const stepSpan = makeMockSpan()
      const inferenceSpan = makeMockSpan()
      const mockTracer = makeMockTracer({ startSpan: vi.fn().mockReturnValueOnce(rootSpan).mockReturnValueOnce(stepSpan).mockReturnValueOnce(inferenceSpan) })
      const observer = createOtelObserver(mockTracer)
      observer.onRunStart!(makeRunContext())
      observer.onStepStart!(makeStepContext())
      observer.onEvent!(makeStepContext(), 'llm.request', { modelId: 'm', providerName: 'p' })

      // act
      observer.onEvent!(makeStepContext(), 'llm.response', { modelId: 'm', providerName: 'p', tokens: { input: 1, output: 1 } })

      // assert
      expect(stepSpan.addEvent).not.toHaveBeenCalled()
      expect(rootSpan.addEvent).not.toHaveBeenCalled()
    })

    it('"llm.response" with non-string modelId — no span retrieved/created; tokens still recorded', () => {
      // arrange
      const tokenHistogram = makeMockHistogram()
      const mp = makeMockMeterProvider({ tokenHistogram })
      const rootSpan = makeMockSpan()
      const stepSpan = makeMockSpan()
      const mockTracer = makeMockTracer({ startSpan: vi.fn().mockReturnValueOnce(rootSpan).mockReturnValueOnce(stepSpan) })
      const observer = createOtelObserver(mockTracer, { meterProvider: mp as unknown as MeterProvider })
      observer.onRunStart!(makeRunContext())
      observer.onStepStart!(makeStepContext())

      // act
      observer.onEvent!(makeStepContext(), 'llm.response', { modelId: 99, providerName: 'openai', tokens: { input: 10, output: 5 } })

      // assert
      expect(mockTracer.startSpan).toHaveBeenCalledTimes(2)
      expect(tokenHistogram.record).toHaveBeenCalledWith(10, { 'gen_ai.token.type': 'input' })
      expect(tokenHistogram.record).toHaveBeenCalledWith(5, { 'gen_ai.token.type': 'output' })
    })

    it('"llm.response" with non-string providerName — no span; tokens still recorded', () => {
      // arrange
      const tokenHistogram = makeMockHistogram()
      const mp = makeMockMeterProvider({ tokenHistogram })
      const rootSpan = makeMockSpan()
      const stepSpan = makeMockSpan()
      const mockTracer = makeMockTracer({ startSpan: vi.fn().mockReturnValueOnce(rootSpan).mockReturnValueOnce(stepSpan) })
      const observer = createOtelObserver(mockTracer, { meterProvider: mp as unknown as MeterProvider })
      observer.onRunStart!(makeRunContext())
      observer.onStepStart!(makeStepContext())

      // act
      observer.onEvent!(makeStepContext(), 'llm.response', { modelId: 'gpt-4o', providerName: undefined, tokens: { input: 7, output: 3 } })

      // assert
      expect(mockTracer.startSpan).toHaveBeenCalledTimes(2)
      expect(tokenHistogram.record).toHaveBeenCalledWith(7, { 'gen_ai.token.type': 'input' })
      expect(tokenHistogram.record).toHaveBeenCalledWith(3, { 'gen_ai.token.type': 'output' })
    })

    it('valid model/provider but no tokens — span closed with model attrs only; no histogram', () => {
      // arrange
      const rootSpan = makeMockSpan()
      const stepSpan = makeMockSpan()
      const inferenceSpan = makeMockSpan()
      const tokenHistogram = makeMockHistogram()
      const mp = makeMockMeterProvider({ tokenHistogram })
      const mockTracer = makeMockTracer({ startSpan: vi.fn().mockReturnValueOnce(rootSpan).mockReturnValueOnce(stepSpan).mockReturnValueOnce(inferenceSpan) })
      const observer = createOtelObserver(mockTracer, { meterProvider: mp as unknown as MeterProvider })
      observer.onRunStart!(makeRunContext())
      observer.onStepStart!(makeStepContext())
      observer.onEvent!(makeStepContext(), 'llm.request', { modelId: 'gpt-4o', providerName: 'openai' })

      // act
      observer.onEvent!(makeStepContext(), 'llm.response', { modelId: 'gpt-4o', providerName: 'openai' })

      // assert
      expect(inferenceSpan.setAttribute).toHaveBeenCalledWith('gen_ai.request.model', 'gpt-4o')
      expect(inferenceSpan.setAttribute).toHaveBeenCalledWith('gen_ai.provider.name', 'openai')
      expect(inferenceSpan.setAttribute).not.toHaveBeenCalledWith('gen_ai.usage.input_tokens', expect.anything())
      expect(inferenceSpan.end).toHaveBeenCalledOnce()
      expect(tokenHistogram.record).not.toHaveBeenCalled()
    })

    it('stopReason absent — span closed without gen_ai.response.finish_reasons', () => {
      // arrange
      const rootSpan = makeMockSpan()
      const stepSpan = makeMockSpan()
      const inferenceSpan = makeMockSpan()
      const mockTracer = makeMockTracer({ startSpan: vi.fn().mockReturnValueOnce(rootSpan).mockReturnValueOnce(stepSpan).mockReturnValueOnce(inferenceSpan) })
      const observer = createOtelObserver(mockTracer)
      observer.onRunStart!(makeRunContext())
      observer.onStepStart!(makeStepContext())
      observer.onEvent!(makeStepContext(), 'llm.request', { modelId: 'gpt-4o', providerName: 'openai' })

      // act
      observer.onEvent!(makeStepContext(), 'llm.response', { modelId: 'gpt-4o', providerName: 'openai', tokens: { input: 5, output: 2 } })

      // assert
      expect(inferenceSpan.setAttribute).toHaveBeenCalledWith('gen_ai.request.model', 'gpt-4o')
      expect(inferenceSpan.setAttribute).not.toHaveBeenCalledWith('gen_ai.response.finish_reasons', expect.anything())
      expect(inferenceSpan.end).toHaveBeenCalledOnce()
    })

  })

  // ---- Group 8: Inference output content capture (captureOutputs) ----

  describe('onEvent — captureOutputs', () => {

    it('captureOutputs: true records "gen_ai.content.completion" on inference span before span.end()', () => {
      // arrange
      const rootSpan = makeMockSpan()
      const stepSpan = makeMockSpan()
      const inferenceSpan = makeMockSpan()
      const mockTracer = makeMockTracer({ startSpan: vi.fn().mockReturnValueOnce(rootSpan).mockReturnValueOnce(stepSpan).mockReturnValueOnce(inferenceSpan) })
      const observer = createOtelObserver(mockTracer, { captureOutputs: true })
      observer.onRunStart!(makeRunContext())
      observer.onStepStart!(makeStepContext())
      observer.onEvent!(makeStepContext(), 'llm.request', { modelId: 'gpt-4o', providerName: 'openai' })
      const output = { text: 'hello world', toolCalls: [] }

      // act
      observer.onEvent!(makeStepContext(), 'llm.response', { modelId: 'gpt-4o', providerName: 'openai', tokens: { input: 5, output: 2 }, output })

      // assert
      expect(inferenceSpan.addEvent).toHaveBeenCalledWith('gen_ai.content.completion', { 'gen_ai.completion': JSON.stringify(output) })
      expect((inferenceSpan.addEvent as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!).toBeLessThan(
        (inferenceSpan.end as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!
      )
    })

    it('captureOutputs: false (default) — no addEvent on inference span', () => {
      // arrange
      const rootSpan = makeMockSpan()
      const stepSpan = makeMockSpan()
      const inferenceSpan = makeMockSpan()
      const mockTracer = makeMockTracer({ startSpan: vi.fn().mockReturnValueOnce(rootSpan).mockReturnValueOnce(stepSpan).mockReturnValueOnce(inferenceSpan) })
      const observer = createOtelObserver(mockTracer)
      observer.onRunStart!(makeRunContext())
      observer.onStepStart!(makeStepContext())
      observer.onEvent!(makeStepContext(), 'llm.request', { modelId: 'gpt-4o', providerName: 'openai' })

      // act
      observer.onEvent!(makeStepContext(), 'llm.response', { modelId: 'gpt-4o', providerName: 'openai', tokens: { input: 1, output: 1 }, output: { text: 'secret' } })

      // assert
      expect(inferenceSpan.addEvent).not.toHaveBeenCalled()
    })

    it('captureOutputs: true with output absent — no span event', () => {
      // arrange
      const rootSpan = makeMockSpan()
      const stepSpan = makeMockSpan()
      const inferenceSpan = makeMockSpan()
      const mockTracer = makeMockTracer({ startSpan: vi.fn().mockReturnValueOnce(rootSpan).mockReturnValueOnce(stepSpan).mockReturnValueOnce(inferenceSpan) })
      const observer = createOtelObserver(mockTracer, { captureOutputs: true })
      observer.onRunStart!(makeRunContext())
      observer.onStepStart!(makeStepContext())
      observer.onEvent!(makeStepContext(), 'llm.request', { modelId: 'gpt-4o', providerName: 'openai' })

      // act
      observer.onEvent!(makeStepContext(), 'llm.response', { modelId: 'gpt-4o', providerName: 'openai', tokens: { input: 1, output: 1 } })

      // assert
      expect(inferenceSpan.addEvent).not.toHaveBeenCalled()
    })

  })

  // ---- Group 9: Tool span lifecycle ("tool.call" / "tool.result") ----

  describe('onEvent — tool spans', () => {

    it('"tool.call" opens INTERNAL span as child of step span with correct attrs', () => {
      // arrange
      const rootSpan = makeMockSpan()
      const stepSpan = makeMockSpan()
      const toolSpan = makeMockSpan()
      const stepCtx = {} as Context // as: sentinel
      const mockTracer = makeMockTracer({ startSpan: vi.fn().mockReturnValueOnce(rootSpan).mockReturnValueOnce(stepSpan).mockReturnValueOnce(toolSpan) })
      vi.spyOn(trace, 'setSpan').mockImplementation((_ctx, span) => span === stepSpan ? stepCtx : ({} as Context))
      const observer = createOtelObserver(mockTracer)
      observer.onRunStart!(makeRunContext())
      observer.onStepStart!(makeStepContext())

      // act
      observer.onEvent!(makeStepContext(), 'tool.call', { toolName: 'search', toolCallId: 'tc-1' })

      // assert
      expect(mockTracer.startSpan).toHaveBeenNthCalledWith(3, 'execute_tool search', { kind: SpanKind.INTERNAL, attributes: { 'gen_ai.tool.name': 'search', 'gen_ai.operation.name': 'execute_tool' } }, stepCtx)
      expect(toolSpan.end).not.toHaveBeenCalled()
    })

    it('"tool.call" with no step span — tool span parented to root span', () => {
      // arrange
      const rootSpan = makeMockSpan()
      const toolSpan = makeMockSpan()
      const rootCtx = {} as Context // as: sentinel
      const mockTracer = makeMockTracer({ startSpan: vi.fn().mockReturnValueOnce(rootSpan).mockReturnValueOnce(toolSpan) })
      vi.spyOn(trace, 'setSpan').mockImplementation((_ctx, span) => span === rootSpan ? rootCtx : ({} as Context))
      const observer = createOtelObserver(mockTracer)
      observer.onRunStart!(makeRunContext())

      // act
      observer.onEvent!(makeStepContext(), 'tool.call', { toolName: 'calc', toolCallId: 'tc-2' })

      // assert
      expect(mockTracer.startSpan).toHaveBeenNthCalledWith(2, 'execute_tool calc', expect.any(Object), rootCtx)
    })

    it('"tool.result" without error — ends span, deletes map entry', () => {
      // arrange
      const rootSpan = makeMockSpan()
      const stepSpan = makeMockSpan()
      const toolSpan = makeMockSpan()
      const mockTracer = makeMockTracer({ startSpan: vi.fn().mockReturnValueOnce(rootSpan).mockReturnValueOnce(stepSpan).mockReturnValueOnce(toolSpan) })
      const observer = createOtelObserver(mockTracer)
      observer.onRunStart!(makeRunContext())
      observer.onStepStart!(makeStepContext())
      observer.onEvent!(makeStepContext(), 'tool.call', { toolName: 'search', toolCallId: 'tc-1' })

      // act
      observer.onEvent!(makeStepContext(), 'tool.result', { toolCallId: 'tc-1' })

      // assert
      expect(toolSpan.end).toHaveBeenCalledOnce()
      expect(toolSpan.setStatus).not.toHaveBeenCalled()
    })

    it('"tool.result" with error — sets ERROR status, ends span', () => {
      // arrange
      const rootSpan = makeMockSpan()
      const stepSpan = makeMockSpan()
      const toolSpan = makeMockSpan()
      const mockTracer = makeMockTracer({ startSpan: vi.fn().mockReturnValueOnce(rootSpan).mockReturnValueOnce(stepSpan).mockReturnValueOnce(toolSpan) })
      const observer = createOtelObserver(mockTracer)
      observer.onRunStart!(makeRunContext())
      observer.onStepStart!(makeStepContext())
      observer.onEvent!(makeStepContext(), 'tool.call', { toolName: 'search', toolCallId: 'tc-err' })

      // act
      observer.onEvent!(makeStepContext(), 'tool.result', { toolCallId: 'tc-err', error: new Error('tool crashed') })

      // assert
      expect(toolSpan.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR, message: 'Error: tool crashed' })
      expect(toolSpan.end).toHaveBeenCalledOnce()
    })

    it('"tool.call" with no root or step span — no span created', () => {
      // arrange
      const mockTracer = makeMockTracer()
      const observer = createOtelObserver(mockTracer)

      // act
      observer.onEvent!(makeStepContext(), 'tool.call', { toolName: 'search', toolCallId: 'tc-1' })

      // assert
      expect(mockTracer.startSpan).not.toHaveBeenCalled()
    })

    it('"tool.result" for unknown toolCallId — no-op', () => {
      // arrange
      const rootSpan = makeMockSpan()
      const stepSpan = makeMockSpan()
      const mockTracer = makeMockTracer({ startSpan: vi.fn().mockReturnValueOnce(rootSpan).mockReturnValueOnce(stepSpan) })
      const observer = createOtelObserver(mockTracer)
      observer.onRunStart!(makeRunContext())
      observer.onStepStart!(makeStepContext())

      // act / assert
      expect(() => observer.onEvent!(makeStepContext(), 'tool.result', { toolCallId: 'unknown' })).not.toThrow()
    })

    it('duplicate "tool.call" same toolCallId — old span overwritten; subsequent "tool.result" closes new span', () => {
      // arrange
      const rootSpan = makeMockSpan()
      const stepSpan = makeMockSpan()
      const toolSpan1 = makeMockSpan()
      const toolSpan2 = makeMockSpan()
      const mockTracer = makeMockTracer({ startSpan: vi.fn().mockReturnValueOnce(rootSpan).mockReturnValueOnce(stepSpan).mockReturnValueOnce(toolSpan1).mockReturnValueOnce(toolSpan2) })
      const observer = createOtelObserver(mockTracer)
      observer.onRunStart!(makeRunContext())
      observer.onStepStart!(makeStepContext())
      observer.onEvent!(makeStepContext(), 'tool.call', { toolName: 'search', toolCallId: 'tc-dup' })

      // act
      observer.onEvent!(makeStepContext(), 'tool.call', { toolName: 'search', toolCallId: 'tc-dup' })

      // assert
      expect(toolSpan1.end).not.toHaveBeenCalled()
      observer.onEvent!(makeStepContext(), 'tool.result', { toolCallId: 'tc-dup' })
      expect(toolSpan2.end).toHaveBeenCalledOnce()
      expect(toolSpan1.end).not.toHaveBeenCalled()
    })

  })

  // ---- Group 10: Tool IO content capture (captureToolIO) ----

  describe('onEvent — captureToolIO', () => {

    it('captureToolIO: true records "gen_ai.tool.input" on tool span', () => {
      // arrange
      const rootSpan = makeMockSpan()
      const stepSpan = makeMockSpan()
      const toolSpan = makeMockSpan()
      const mockTracer = makeMockTracer({ startSpan: vi.fn().mockReturnValueOnce(rootSpan).mockReturnValueOnce(stepSpan).mockReturnValueOnce(toolSpan) })
      const observer = createOtelObserver(mockTracer, { captureToolIO: true })
      observer.onRunStart!(makeRunContext())
      observer.onStepStart!(makeStepContext())
      const input = { query: 'latest news' }

      // act
      observer.onEvent!(makeStepContext(), 'tool.call', { toolName: 'search', toolCallId: 'tc-1', input })

      // assert
      expect(toolSpan.addEvent).toHaveBeenCalledWith('gen_ai.tool.input', { 'gen_ai.tool.input': JSON.stringify(input) })
    })

    it('captureToolIO: false (default) — no span event on "tool.call"', () => {
      // arrange
      const rootSpan = makeMockSpan()
      const stepSpan = makeMockSpan()
      const toolSpan = makeMockSpan()
      const mockTracer = makeMockTracer({ startSpan: vi.fn().mockReturnValueOnce(rootSpan).mockReturnValueOnce(stepSpan).mockReturnValueOnce(toolSpan) })
      const observer = createOtelObserver(mockTracer)
      observer.onRunStart!(makeRunContext())
      observer.onStepStart!(makeStepContext())

      // act
      observer.onEvent!(makeStepContext(), 'tool.call', { toolName: 'search', toolCallId: 'tc-1', input: { query: 'secret' } })

      // assert
      expect(toolSpan.addEvent).not.toHaveBeenCalled()
    })

    it('captureToolIO: true with input absent — no span event on "tool.call"', () => {
      // arrange
      const rootSpan = makeMockSpan()
      const stepSpan = makeMockSpan()
      const toolSpan = makeMockSpan()
      const mockTracer = makeMockTracer({ startSpan: vi.fn().mockReturnValueOnce(rootSpan).mockReturnValueOnce(stepSpan).mockReturnValueOnce(toolSpan) })
      const observer = createOtelObserver(mockTracer, { captureToolIO: true })
      observer.onRunStart!(makeRunContext())
      observer.onStepStart!(makeStepContext())

      // act
      observer.onEvent!(makeStepContext(), 'tool.call', { toolName: 'search', toolCallId: 'tc-1' })

      // assert
      expect(toolSpan.addEvent).not.toHaveBeenCalled()
    })

    it('captureToolIO: true records "gen_ai.tool.output" before span.end()', () => {
      // arrange
      const rootSpan = makeMockSpan()
      const stepSpan = makeMockSpan()
      const toolSpan = makeMockSpan()
      const mockTracer = makeMockTracer({ startSpan: vi.fn().mockReturnValueOnce(rootSpan).mockReturnValueOnce(stepSpan).mockReturnValueOnce(toolSpan) })
      const observer = createOtelObserver(mockTracer, { captureToolIO: true })
      observer.onRunStart!(makeRunContext())
      observer.onStepStart!(makeStepContext())
      observer.onEvent!(makeStepContext(), 'tool.call', { toolName: 'search', toolCallId: 'tc-1' })
      const result = [{ title: 'result 1', url: 'http://...' }]

      // act
      observer.onEvent!(makeStepContext(), 'tool.result', { toolCallId: 'tc-1', result })

      // assert
      expect(toolSpan.addEvent).toHaveBeenCalledWith('gen_ai.tool.output', { 'gen_ai.tool.output': JSON.stringify(result) })
      expect((toolSpan.addEvent as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!).toBeLessThan(
        (toolSpan.end as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!
      )
    })

    it('captureToolIO: false (default) — no span event on "tool.result"', () => {
      // arrange
      const rootSpan = makeMockSpan()
      const stepSpan = makeMockSpan()
      const toolSpan = makeMockSpan()
      const mockTracer = makeMockTracer({ startSpan: vi.fn().mockReturnValueOnce(rootSpan).mockReturnValueOnce(stepSpan).mockReturnValueOnce(toolSpan) })
      const observer = createOtelObserver(mockTracer)
      observer.onRunStart!(makeRunContext())
      observer.onStepStart!(makeStepContext())
      observer.onEvent!(makeStepContext(), 'tool.call', { toolName: 'search', toolCallId: 'tc-1' })

      // act
      observer.onEvent!(makeStepContext(), 'tool.result', { toolCallId: 'tc-1', result: [{ item: 1 }] })

      // assert
      expect(toolSpan.addEvent).not.toHaveBeenCalled()
    })

    it('captureToolIO: true with result absent — no span event on "tool.result"', () => {
      // arrange
      const rootSpan = makeMockSpan()
      const stepSpan = makeMockSpan()
      const toolSpan = makeMockSpan()
      const mockTracer = makeMockTracer({ startSpan: vi.fn().mockReturnValueOnce(rootSpan).mockReturnValueOnce(stepSpan).mockReturnValueOnce(toolSpan) })
      const observer = createOtelObserver(mockTracer, { captureToolIO: true })
      observer.onRunStart!(makeRunContext())
      observer.onStepStart!(makeStepContext())
      observer.onEvent!(makeStepContext(), 'tool.call', { toolName: 'search', toolCallId: 'tc-1' })

      // act
      observer.onEvent!(makeStepContext(), 'tool.result', { toolCallId: 'tc-1' })

      // assert
      expect(toolSpan.addEvent).not.toHaveBeenCalled()
    })

  })

  // ---- Group 11: Non-reserved event fallback ----

  describe('onEvent — non-reserved event fallback', () => {

    it('calls stepSpan.addEvent(type) when step span is active — payload not forwarded', () => {
      // arrange
      const rootSpan = makeMockSpan()
      const stepSpan = makeMockSpan()
      const mockTracer = makeMockTracer({ startSpan: vi.fn().mockReturnValueOnce(rootSpan).mockReturnValueOnce(stepSpan) })
      const observer = createOtelObserver(mockTracer)
      observer.onRunStart!(makeRunContext())
      observer.onStepStart!(makeStepContext())

      // act
      observer.onEvent!(makeStepContext(), 'custom.event', { someData: true })

      // assert
      expect(stepSpan.addEvent).toHaveBeenCalledWith('custom.event')
      expect(rootSpan.addEvent).not.toHaveBeenCalled()
    })

    it('calls rootSpan.addEvent(type) when no step span active', () => {
      // arrange
      const rootSpan = makeMockSpan()
      const mockTracer = makeMockTracer({ startSpan: vi.fn().mockReturnValue(rootSpan) })
      const observer = createOtelObserver(mockTracer)
      observer.onRunStart!(makeRunContext())

      // act
      observer.onEvent!(makeStepContext(), 'app.started', {})

      // assert
      expect(rootSpan.addEvent).toHaveBeenCalledWith('app.started')
    })

    it('non-reserved event with no spans active — no-op', () => {
      // arrange
      const mockTracer = makeMockTracer()
      const observer = createOtelObserver(mockTracer)

      // act / assert
      expect(() => observer.onEvent!(makeStepContext(), 'some.event', {})).not.toThrow()
    })

  })

  // ---- Group 12: Truncation guard ----

  describe('truncation', () => {

    it('string exactly at maxContentLength is returned unchanged', () => {
      // arrange
      const rootSpan = makeMockSpan()
      const stepSpan = makeMockSpan()
      const inferenceSpan = makeMockSpan()
      const maxContentLength = 20
      const mockTracer = makeMockTracer({ startSpan: vi.fn().mockReturnValueOnce(rootSpan).mockReturnValueOnce(stepSpan).mockReturnValueOnce(inferenceSpan) })
      const observer = createOtelObserver(mockTracer, { captureInputs: true, maxContentLength })
      observer.onRunStart!(makeRunContext())
      observer.onStepStart!(makeStepContext())
      // build messages such that JSON.stringify is exactly 20 chars
      const messages = [{ r: 'u', c: 'hi' }] // JSON: '[{"r":"u","c":"hi"}]' = 20 chars
      expect(JSON.stringify(messages).length).toBe(20)

      // act
      observer.onEvent!(makeStepContext(), 'llm.request', { modelId: 'm', providerName: 'p', messages })

      // assert
      expect(inferenceSpan.addEvent).toHaveBeenCalledWith('gen_ai.content.prompt', { 'gen_ai.prompt': JSON.stringify(messages) })
      const value = (inferenceSpan.addEvent as ReturnType<typeof vi.fn>).mock.calls[0]![1]['gen_ai.prompt']
      expect(value.length).toBe(20)
      expect(value.endsWith('…')).toBe(false)
    })

    it('string one character over maxContentLength — truncated to limit + "…"', () => {
      // arrange
      const rootSpan = makeMockSpan()
      const stepSpan = makeMockSpan()
      const inferenceSpan = makeMockSpan()
      const maxContentLength = 20
      const mockTracer = makeMockTracer({ startSpan: vi.fn().mockReturnValueOnce(rootSpan).mockReturnValueOnce(stepSpan).mockReturnValueOnce(inferenceSpan) })
      const observer = createOtelObserver(mockTracer, { captureInputs: true, maxContentLength })
      observer.onRunStart!(makeRunContext())
      observer.onStepStart!(makeStepContext())
      // build messages such that JSON.stringify is exactly 21 chars
      const messages = [{ r: 'u', c: 'hi!' }] // JSON: '[{"r":"u","c":"hi!"}]' = 21 chars
      expect(JSON.stringify(messages).length).toBe(21)

      // act
      observer.onEvent!(makeStepContext(), 'llm.request', { modelId: 'm', providerName: 'p', messages })

      // assert
      const value = (inferenceSpan.addEvent as ReturnType<typeof vi.fn>).mock.calls[0]![1]['gen_ai.prompt']
      expect(value.length).toBe(21)
      expect(value.endsWith('…')).toBe(true)
      expect(value.startsWith(JSON.stringify(messages).slice(0, 20))).toBe(true)
    })

    it('custom maxContentLength: 100 — 101-char string truncated correctly', () => {
      // arrange
      const rootSpan = makeMockSpan()
      const stepSpan = makeMockSpan()
      const inferenceSpan = makeMockSpan()
      const mockTracer = makeMockTracer({ startSpan: vi.fn().mockReturnValueOnce(rootSpan).mockReturnValueOnce(stepSpan).mockReturnValueOnce(inferenceSpan) })
      const observer = createOtelObserver(mockTracer, { captureInputs: true, maxContentLength: 100 })
      observer.onRunStart!(makeRunContext())
      observer.onStepStart!(makeStepContext())
      // build messages whose JSON.stringify is exactly 101 chars
      const longStr = 'x'.repeat(97) // "x".repeat(97) wrapped in JSON: '["' + x*97 + '"]' = 101 chars
      const messages = [longStr]
      expect(JSON.stringify(messages).length).toBe(101)

      // act
      observer.onEvent!(makeStepContext(), 'llm.request', { modelId: 'm', providerName: 'p', messages })

      // assert
      const value = (inferenceSpan.addEvent as ReturnType<typeof vi.fn>).mock.calls[0]![1]['gen_ai.prompt']
      expect(value.length).toBe(101)
      expect(value.endsWith('…')).toBe(true)
    })

    it('captureInputs: true, maxContentLength: 50 — "gen_ai.prompt" value is truncated', () => {
      // arrange
      const rootSpan = makeMockSpan()
      const stepSpan = makeMockSpan()
      const inferenceSpan = makeMockSpan()
      const mockTracer = makeMockTracer({ startSpan: vi.fn().mockReturnValueOnce(rootSpan).mockReturnValueOnce(stepSpan).mockReturnValueOnce(inferenceSpan) })
      const observer = createOtelObserver(mockTracer, { captureInputs: true, maxContentLength: 50 })
      observer.onRunStart!(makeRunContext())
      observer.onStepStart!(makeStepContext())
      // messages whose JSON.stringify is longer than 50 chars
      const messages = [{ role: 'user', content: 'this is a long message that exceeds the limit for sure' }]
      expect(JSON.stringify(messages).length).toBeGreaterThan(50)

      // act
      observer.onEvent!(makeStepContext(), 'llm.request', { modelId: 'm', providerName: 'p', messages })

      // assert
      const value = (inferenceSpan.addEvent as ReturnType<typeof vi.fn>).mock.calls[0]![1]['gen_ai.prompt']
      expect(value.length).toBe(51)
      expect(value.endsWith('…')).toBe(true)
    })

    it('captureOutputs: true, maxContentLength: 50 — "gen_ai.completion" value is truncated', () => {
      // arrange
      const rootSpan = makeMockSpan()
      const stepSpan = makeMockSpan()
      const inferenceSpan = makeMockSpan()
      const mockTracer = makeMockTracer({ startSpan: vi.fn().mockReturnValueOnce(rootSpan).mockReturnValueOnce(stepSpan).mockReturnValueOnce(inferenceSpan) })
      const observer = createOtelObserver(mockTracer, { captureOutputs: true, maxContentLength: 50 })
      observer.onRunStart!(makeRunContext())
      observer.onStepStart!(makeStepContext())
      observer.onEvent!(makeStepContext(), 'llm.request', { modelId: 'm', providerName: 'p' })
      // output whose JSON.stringify is longer than 50 chars
      const output = { text: 'this is a long output that definitely exceeds the limit' }
      expect(JSON.stringify(output).length).toBeGreaterThan(50)

      // act
      observer.onEvent!(makeStepContext(), 'llm.response', { modelId: 'm', providerName: 'p', tokens: { input: 1, output: 1 }, output })

      // assert
      const value = (inferenceSpan.addEvent as ReturnType<typeof vi.fn>).mock.calls[0]![1]['gen_ai.completion']
      expect(value.length).toBe(51)
      expect(value.endsWith('…')).toBe(true)
    })

    it('captureToolIO: true, maxContentLength: 50 — "gen_ai.tool.input" value is truncated', () => {
      // arrange
      const rootSpan = makeMockSpan()
      const stepSpan = makeMockSpan()
      const toolSpan = makeMockSpan()
      const mockTracer = makeMockTracer({ startSpan: vi.fn().mockReturnValueOnce(rootSpan).mockReturnValueOnce(stepSpan).mockReturnValueOnce(toolSpan) })
      const observer = createOtelObserver(mockTracer, { captureToolIO: true, maxContentLength: 50 })
      observer.onRunStart!(makeRunContext())
      observer.onStepStart!(makeStepContext())
      // input whose JSON.stringify is longer than 50 chars
      const input = { query: 'a very long search query that exceeds the limit for content' }
      expect(JSON.stringify(input).length).toBeGreaterThan(50)

      // act
      observer.onEvent!(makeStepContext(), 'tool.call', { toolName: 'search', toolCallId: 'tc-1', input })

      // assert
      const value = (toolSpan.addEvent as ReturnType<typeof vi.fn>).mock.calls[0]![1]['gen_ai.tool.input']
      expect(value.length).toBe(51)
      expect(value.endsWith('…')).toBe(true)
    })

    it('captureToolIO: true, maxContentLength: 50 — "gen_ai.tool.output" value is truncated', () => {
      // arrange
      const rootSpan = makeMockSpan()
      const stepSpan = makeMockSpan()
      const toolSpan = makeMockSpan()
      const mockTracer = makeMockTracer({ startSpan: vi.fn().mockReturnValueOnce(rootSpan).mockReturnValueOnce(stepSpan).mockReturnValueOnce(toolSpan) })
      const observer = createOtelObserver(mockTracer, { captureToolIO: true, maxContentLength: 50 })
      observer.onRunStart!(makeRunContext())
      observer.onStepStart!(makeStepContext())
      observer.onEvent!(makeStepContext(), 'tool.call', { toolName: 'search', toolCallId: 'tc-1' })
      // result whose JSON.stringify is longer than 50 chars
      const result = [{ title: 'Some very long result title that exceeds the limit' }]
      expect(JSON.stringify(result).length).toBeGreaterThan(50)

      // act
      observer.onEvent!(makeStepContext(), 'tool.result', { toolCallId: 'tc-1', result })

      // assert
      const value = (toolSpan.addEvent as ReturnType<typeof vi.fn>).mock.calls[0]![1]['gen_ai.tool.output']
      expect(value.length).toBe(51)
      expect(value.endsWith('…')).toBe(true)
    })

  })

  // ---- Group 13: Per-step counter reset and LIFO inference matching ----

  describe('per-step inference counter', () => {

    it('counter resets to 0 on onStepStart after a multi-request step', () => {
      // arrange
      const rootSpan = makeMockSpan()
      const step1Span = makeMockSpan()
      const inf1 = makeMockSpan()
      const step2Span = makeMockSpan()
      const inf3 = makeMockSpan()
      const mockTracer = makeMockTracer({ startSpan: vi.fn().mockReturnValueOnce(rootSpan).mockReturnValueOnce(step1Span).mockReturnValueOnce(inf1).mockReturnValueOnce(step2Span).mockReturnValueOnce(inf3) })
      const observer = createOtelObserver(mockTracer)
      observer.onRunStart!(makeRunContext())
      observer.onStepStart!(makeStepContext({ stepName: 'step-1' }))
      observer.onEvent!(makeStepContext(), 'llm.request', { modelId: 'm', providerName: 'p' }) // counter → 1, stored at key 1
      observer.onEvent!(makeStepContext(), 'llm.response', { modelId: 'm', providerName: 'p', tokens: { input: 1, output: 1 } }) // retrieves key 1 (inf1); counter → 0

      // act
      observer.onStepStart!(makeStepContext({ stepName: 'step-2' })) // counter reset to 0
      observer.onEvent!(makeStepContext(), 'llm.request', { modelId: 'm', providerName: 'p' }) // counter → 1, stored at key 1 (inf3)
      observer.onEvent!(makeStepContext(), 'llm.response', { modelId: 'm', providerName: 'p', tokens: { input: 1, output: 1 } }) // retrieves key 1 (inf3)

      // assert
      expect(inf3.end).toHaveBeenCalledOnce()
      expect(inf1.end).toHaveBeenCalledOnce()
    })

    it('two concurrent "llm.request" before responses — LIFO matching closes correct spans', () => {
      // arrange
      const rootSpan = makeMockSpan()
      const stepSpan = makeMockSpan()
      const inf1 = makeMockSpan()
      const inf2 = makeMockSpan()
      const mockTracer = makeMockTracer({ startSpan: vi.fn().mockReturnValueOnce(rootSpan).mockReturnValueOnce(stepSpan).mockReturnValueOnce(inf1).mockReturnValueOnce(inf2) })
      const observer = createOtelObserver(mockTracer)
      observer.onRunStart!(makeRunContext())
      observer.onStepStart!(makeStepContext())
      observer.onEvent!(makeStepContext(), 'llm.request', { modelId: 'model-a', providerName: 'p' }) // counter → 1, key 1 = inf1
      observer.onEvent!(makeStepContext(), 'llm.request', { modelId: 'model-b', providerName: 'p' }) // counter → 2, key 2 = inf2

      // act — responses in same order: LIFO means counter decrements from 2
      observer.onEvent!(makeStepContext(), 'llm.response', { modelId: 'model-b', providerName: 'p', tokens: { input: 1, output: 1 } }) // counter=2 → retrieves key 2 (inf2); counter → 1
      observer.onEvent!(makeStepContext(), 'llm.response', { modelId: 'model-a', providerName: 'p', tokens: { input: 1, output: 1 } }) // counter=1 → retrieves key 1 (inf1); counter → 0

      // assert
      expect(inf2.end).toHaveBeenCalledOnce()
      expect(inf1.end).toHaveBeenCalledOnce()
      expect(inf2.setAttribute).toHaveBeenCalledWith('gen_ai.request.model', 'model-b')
      expect(inf1.setAttribute).toHaveBeenCalledWith('gen_ai.request.model', 'model-a')
    })

  })

  // ---- Group 14: JSON serialisation error handling ----

  describe('JSON serialisation error handling', () => {

    it('captureInputs: true, circular messages — no event, no throw', () => {
      // arrange
      const rootSpan = makeMockSpan()
      const stepSpan = makeMockSpan()
      const inferenceSpan = makeMockSpan()
      const mockTracer = makeMockTracer({ startSpan: vi.fn().mockReturnValueOnce(rootSpan).mockReturnValueOnce(stepSpan).mockReturnValueOnce(inferenceSpan) })
      const observer = createOtelObserver(mockTracer, { captureInputs: true })
      observer.onRunStart!(makeRunContext())
      observer.onStepStart!(makeStepContext())
      const circular: Record<string, unknown> = {}
      circular.self = circular

      // act / assert
      expect(() => observer.onEvent!(makeStepContext(), 'llm.request', { modelId: 'm', providerName: 'p', messages: circular })).not.toThrow()
      expect(inferenceSpan.addEvent).not.toHaveBeenCalled()
    })

    it('captureOutputs: true, circular output — no event, no throw; span still closed', () => {
      // arrange
      const rootSpan = makeMockSpan()
      const stepSpan = makeMockSpan()
      const inferenceSpan = makeMockSpan()
      const mockTracer = makeMockTracer({ startSpan: vi.fn().mockReturnValueOnce(rootSpan).mockReturnValueOnce(stepSpan).mockReturnValueOnce(inferenceSpan) })
      const observer = createOtelObserver(mockTracer, { captureOutputs: true })
      observer.onRunStart!(makeRunContext())
      observer.onStepStart!(makeStepContext())
      observer.onEvent!(makeStepContext(), 'llm.request', { modelId: 'm', providerName: 'p' })
      const circular: Record<string, unknown> = {}
      circular.self = circular

      // act / assert
      expect(() => observer.onEvent!(makeStepContext(), 'llm.response', { modelId: 'm', providerName: 'p', tokens: { input: 1, output: 1 }, output: circular })).not.toThrow()
      expect(inferenceSpan.addEvent).not.toHaveBeenCalled()
      expect(inferenceSpan.end).toHaveBeenCalledOnce()
    })

    it('captureToolIO: true, circular input on "tool.call" — no event, no throw', () => {
      // arrange
      const rootSpan = makeMockSpan()
      const stepSpan = makeMockSpan()
      const toolSpan = makeMockSpan()
      const mockTracer = makeMockTracer({ startSpan: vi.fn().mockReturnValueOnce(rootSpan).mockReturnValueOnce(stepSpan).mockReturnValueOnce(toolSpan) })
      const observer = createOtelObserver(mockTracer, { captureToolIO: true })
      observer.onRunStart!(makeRunContext())
      observer.onStepStart!(makeStepContext())
      const circular: Record<string, unknown> = {}
      circular.self = circular

      // act / assert
      expect(() => observer.onEvent!(makeStepContext(), 'tool.call', { toolName: 'search', toolCallId: 'tc-1', input: circular })).not.toThrow()
      expect(toolSpan.addEvent).not.toHaveBeenCalled()
    })

    it('captureToolIO: true, circular result on "tool.result" — no event, no throw; span still closed', () => {
      // arrange
      const rootSpan = makeMockSpan()
      const stepSpan = makeMockSpan()
      const toolSpan = makeMockSpan()
      const mockTracer = makeMockTracer({ startSpan: vi.fn().mockReturnValueOnce(rootSpan).mockReturnValueOnce(stepSpan).mockReturnValueOnce(toolSpan) })
      const observer = createOtelObserver(mockTracer, { captureToolIO: true })
      observer.onRunStart!(makeRunContext())
      observer.onStepStart!(makeStepContext())
      observer.onEvent!(makeStepContext(), 'tool.call', { toolName: 'search', toolCallId: 'tc-1' })
      const circular: Record<string, unknown> = {}
      circular.self = circular

      // act / assert
      expect(() => observer.onEvent!(makeStepContext(), 'tool.result', { toolCallId: 'tc-1', result: circular })).not.toThrow()
      expect(toolSpan.addEvent).not.toHaveBeenCalled()
      expect(toolSpan.end).toHaveBeenCalledOnce()
    })

  })

  // ---- Group 15: Factory isolation and initialization ----

  describe('factory isolation and initialization', () => {

    it('two Observer instances from same factory have isolated closure state', () => {
      // arrange
      const span1 = makeMockSpan()
      const span2 = makeMockSpan()
      const mockTracer = makeMockTracer({ startSpan: vi.fn().mockReturnValueOnce(span1).mockReturnValueOnce(span2) })
      const obs1 = createOtelObserver(mockTracer)
      const obs2 = createOtelObserver(mockTracer)
      const ctx1 = makeRunContext({ agentId: 'agent-1', sessionId: 'sess-1' })
      const ctx2 = makeRunContext({ agentId: 'agent-2', sessionId: 'sess-2' })

      // act
      obs1.onRunStart!(ctx1)
      obs2.onRunStart!(ctx2)
      obs1.onRunEnd!(ctx1, { signal: 'done', durationMs: 100 })
      obs2.onRunEnd!(ctx2, { signal: 'done', durationMs: 200 })

      // assert
      expect(mockTracer.startSpan).toHaveBeenCalledTimes(2)
      expect(mockTracer.startSpan).toHaveBeenNthCalledWith(1, 'invoke_agent agent-1', expect.any(Object), expect.anything())
      expect(mockTracer.startSpan).toHaveBeenNthCalledWith(2, 'invoke_agent agent-2', expect.any(Object), expect.anything())
      expect(span1.end).toHaveBeenCalledOnce()
      expect(span2.end).toHaveBeenCalledOnce()
    })

    it('no-options Observer — no metrics, no content captured, spans use context.active()', () => {
      // arrange
      const mockTracer = makeMockTracer({ startSpan: vi.fn().mockReturnValue(makeMockSpan()) })
      const activeCtx = {} as Context // as: sentinel
      vi.spyOn(context, 'active').mockReturnValue(activeCtx)
      vi.spyOn(trace, 'setSpan').mockReturnValue(activeCtx) // prevent real Context.setValue call on plain-object mock
      const observer = createOtelObserver(mockTracer)

      // act
      observer.onRunStart!(makeRunContext({ agentId: 'a', sessionId: 's' }))
      observer.onStepStart!(makeStepContext())
      observer.onEvent!(makeStepContext(), 'llm.request', { modelId: 'm', providerName: 'p', messages: [{ role: 'user', content: 'hi' }] })
      observer.onEvent!(makeStepContext(), 'llm.response', { modelId: 'm', providerName: 'p', tokens: { input: 1, output: 1 }, output: { text: 'ok' } })
      observer.onStepEnd!(makeStepContext(), { durationMs: 10 })
      observer.onRunEnd!(makeRunContext(), { signal: 'done', durationMs: 500 })

      // assert
      expect(mockTracer.startSpan).toHaveBeenNthCalledWith(1, expect.any(String), expect.any(Object), activeCtx)
      const allSpans = (mockTracer.startSpan as ReturnType<typeof vi.fn>).mock.results
      expect(allSpans.every((s: any) => (s.value.addEvent as ReturnType<typeof vi.fn>).mock.calls.length === 0)).toBe(true) // any: MockResult<any> is a union with optional `value`; narrowing here would add noise with no benefit
    })

    it('meterProvider provided — getMeter and both histograms created once at factory time', () => {
      // arrange
      const mockMeter = { createHistogram: vi.fn().mockReturnValue(makeMockHistogram()) }
      const meterProvider = { getMeter: vi.fn().mockReturnValue(mockMeter) }
      const mockTracer = makeMockTracer()

      // act
      createOtelObserver(mockTracer, { meterProvider: meterProvider as unknown as MeterProvider })

      // assert
      expect(meterProvider.getMeter).toHaveBeenCalledOnce()
      expect(meterProvider.getMeter).toHaveBeenCalledWith('@noetaris/harness-otel', '0.1.0')
      expect(mockMeter.createHistogram).toHaveBeenCalledTimes(2)
      expect(mockMeter.createHistogram).toHaveBeenCalledWith('gen_ai.client.token.usage', expect.objectContaining({ unit: '{token}' }))
      expect(mockMeter.createHistogram).toHaveBeenCalledWith('gen_ai.client.operation.duration', expect.objectContaining({ unit: 's' }))
    })

  })

})
