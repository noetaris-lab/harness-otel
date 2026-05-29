import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  type Span,
  type Tracer,
  type MeterProvider,
  type Meter,
  type Histogram,
  SpanStatusCode,
  SpanKind,
  context,
  trace,
} from '@opentelemetry/api'
import { createOtelObserver } from './otel-observer.js'

// ---- Stub helpers ----

function makeStubSpan(): Span {
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

function makeStubTracer(spans: Span[]): Tracer {
  const startSpan = vi.fn()
  spans.forEach(s => startSpan.mockReturnValueOnce(s))
  return { startSpan } as unknown as Tracer // as: partial stub — only startSpan is needed
}

function makeStubMeterWithHistograms(
  tokenHistogram: Histogram,
  durationHistogram: Histogram,
): Meter {
  const createHistogram = vi.fn().mockImplementation((name: string) => {
    if (name === 'gen_ai.client.token.usage') return tokenHistogram
    if (name === 'gen_ai.client.operation.duration') return durationHistogram
    return { record: vi.fn() }
  })
  return { createHistogram } as unknown as Meter // as: partial stub
}

function makeStubMeterProvider(tokenHistogram: Histogram, durationHistogram: Histogram): MeterProvider {
  const meter = makeStubMeterWithHistograms(tokenHistogram, durationHistogram)
  return {
    getMeter: vi.fn().mockReturnValue(meter),
  } as unknown as MeterProvider // as: partial stub — only getMeter is needed
}

function makeHistogramStub(): Histogram {
  return { record: vi.fn() } as unknown as Histogram // as: partial stub — only record is needed
}

// ---- Tests ----

describe('createOtelObserver', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  // ---- Group 1: Root span creation (onRunStart) ----

  describe('onRunStart', () => {
    it('creates "invoke_agent {agentId}" span with semconv attributes using context.active() when no options', () => {
      // arrange
      const mockRootSpan = makeStubSpan()
      const mockTracer = makeStubTracer([mockRootSpan])
      const activeCtx = {} as ReturnType<typeof context.active> // as: sentinel object for identity check
      vi.spyOn(context, 'active').mockReturnValue(activeCtx)
      const observer = createOtelObserver(mockTracer)
      const ctx = { agentId: 'agent-abc', sessionId: 'sess-xyz', runId: 'run-1' }

      // act
      observer.onRunStart!(ctx)

      // assert
      expect(mockTracer.startSpan).toHaveBeenCalledWith(
        'invoke_agent agent-abc',
        { attributes: { 'gen_ai.agent.id': 'agent-abc', 'gen_ai.conversation.id': 'sess-xyz', 'gen_ai.operation.name': 'invoke_agent' } },
        activeCtx,
      )
    })

    it('uses options.parentContext as span parent when provided', () => {
      // arrange
      const mockRootSpan = makeStubSpan()
      const mockTracer = makeStubTracer([mockRootSpan])
      const explicitCtx = {} as ReturnType<typeof context.active> // as: sentinel object for identity check
      const observer = createOtelObserver(mockTracer, { parentContext: explicitCtx })
      const ctx = { agentId: 'agent-abc', sessionId: 'sess-xyz', runId: 'run-1' }

      // act
      observer.onRunStart!(ctx)

      // assert
      expect(mockTracer.startSpan).toHaveBeenCalledWith('invoke_agent agent-abc', expect.any(Object), explicitCtx)
    })

    it('merges options.attributes with built-in semconv attributes on root span', () => {
      // arrange
      const mockRootSpan = makeStubSpan()
      const mockTracer = makeStubTracer([mockRootSpan])
      const observer = createOtelObserver(mockTracer, { attributes: { 'service.version': '1.2.3' } })
      const ctx = { agentId: 'agent-abc', sessionId: 'sess-xyz', runId: 'run-1' }

      // act
      observer.onRunStart!(ctx)

      // assert
      expect(mockTracer.startSpan).toHaveBeenCalledWith(
        'invoke_agent agent-abc',
        { attributes: expect.objectContaining({ 'service.version': '1.2.3', 'gen_ai.agent.id': 'agent-abc', 'gen_ai.conversation.id': 'sess-xyz', 'gen_ai.operation.name': 'invoke_agent' }) },
        expect.anything(),
      )
    })

    it('built-in attributes take precedence over conflicting options.attributes', () => {
      // arrange
      const mockRootSpan = makeStubSpan()
      const mockTracer = makeStubTracer([mockRootSpan])
      const observer = createOtelObserver(mockTracer, { attributes: { 'gen_ai.agent.id': 'OVERRIDDEN', 'gen_ai.operation.name': 'OVERRIDDEN' } })
      const ctx = { agentId: 'agent-abc', sessionId: 'sess-xyz', runId: 'run-1' }

      // act
      observer.onRunStart!(ctx)

      // assert
      expect(mockTracer.startSpan).toHaveBeenCalledWith(
        'invoke_agent agent-abc',
        { attributes: expect.objectContaining({ 'gen_ai.agent.id': 'agent-abc', 'gen_ai.operation.name': 'invoke_agent' }) },
        expect.anything(),
      )
    })
  })

  // ---- Group 2: Step span creation (onStepStart) ----

  describe('onStepStart', () => {
    it('creates "harness.step {stepName}" span with gen_ai.step.name attribute as child of root span', () => {
      // arrange
      const mockRootSpan = makeStubSpan()
      const mockStepSpan = makeStubSpan()
      const mockTracer = makeStubTracer([mockRootSpan, mockStepSpan])
      const stepParentCtx = {} as ReturnType<typeof context.active> // as: sentinel object for identity check
      vi.spyOn(trace, 'setSpan').mockReturnValue(stepParentCtx)
      const observer = createOtelObserver(mockTracer)
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'r' })

      // act
      observer.onStepStart!({ agentId: 'a', sessionId: 's', stepName: 'plan' })

      // assert
      expect(mockTracer.startSpan).toHaveBeenCalledWith(
        'harness.step plan',
        { attributes: { 'gen_ai.step.name': 'plan' } },
        stepParentCtx,
      )
    })

    it('is a no-op when no root span is active', () => {
      // arrange
      const mockTracer = makeStubTracer([])

      // act
      const observer = createOtelObserver(mockTracer)
      observer.onStepStart!({ agentId: 'a', sessionId: 's', stepName: 'plan' })

      // assert
      expect(mockTracer.startSpan).not.toHaveBeenCalled()
    })
  })

  // ---- Group 3: Step lifecycle (onStepEnd and onStepError) ----

  describe('onStepEnd', () => {
    it('ends the active step span', () => {
      // arrange
      const mockRootSpan = makeStubSpan()
      const mockStepSpan = makeStubSpan()
      const mockTracer = makeStubTracer([mockRootSpan, mockStepSpan])
      const observer = createOtelObserver(mockTracer)
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'r' })
      observer.onStepStart!({ agentId: 'a', sessionId: 's', stepName: 'plan' })

      // act
      observer.onStepEnd!({ agentId: 'a', sessionId: 's', stepName: 'plan' }, { durationMs: 500 })

      // assert
      expect(mockStepSpan.end).toHaveBeenCalledOnce()
    })

    it('does not record any duration metric at step scope', () => {
      // arrange
      const mockDurationHistogram = makeHistogramStub()
      const mockTokenHistogram = makeHistogramStub()
      const mockMeterProvider = makeStubMeterProvider(mockTokenHistogram, mockDurationHistogram)
      const mockRootSpan = makeStubSpan()
      const mockStepSpan = makeStubSpan()
      const mockTracer = makeStubTracer([mockRootSpan, mockStepSpan])
      const observer = createOtelObserver(mockTracer, { meterProvider: mockMeterProvider })
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'r' })
      observer.onStepStart!({ agentId: 'a', sessionId: 's', stepName: 'plan' })

      // act
      observer.onStepEnd!({ agentId: 'a', sessionId: 's', stepName: 'plan' }, { durationMs: 500 })

      // assert
      expect(mockDurationHistogram.record).not.toHaveBeenCalled()
    })

    it('clears step span reference so subsequent call is a true no-op', () => {
      // arrange
      const mockRootSpan = makeStubSpan()
      const mockStepSpan = makeStubSpan()
      const mockTracer = makeStubTracer([mockRootSpan, mockStepSpan])
      const observer = createOtelObserver(mockTracer)
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'r' })
      observer.onStepStart!({ agentId: 'a', sessionId: 's', stepName: 'plan' })
      observer.onStepEnd!({ agentId: 'a', sessionId: 's', stepName: 'plan' }, { durationMs: 100 })

      // act
      observer.onStepEnd!({ agentId: 'a', sessionId: 's', stepName: 'plan' }, { durationMs: 100 })

      // assert
      expect(mockStepSpan.end).toHaveBeenCalledOnce()
    })

    it('is a no-op when no step span was ever started', () => {
      // arrange
      const mockRootSpan = makeStubSpan()
      const mockTracer = makeStubTracer([mockRootSpan])
      const observer = createOtelObserver(mockTracer)
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'r' })

      // act / assert
      expect(() => observer.onStepEnd!({ agentId: 'a', sessionId: 's', stepName: 'plan' }, { durationMs: 0 })).not.toThrow()
    })

    it('sets ERROR status and ends step span on onStepError', () => {
      // arrange
      const mockRootSpan = makeStubSpan()
      const mockStepSpan = makeStubSpan()
      const mockTracer = makeStubTracer([mockRootSpan, mockStepSpan])
      const observer = createOtelObserver(mockTracer)
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'r' })
      observer.onStepStart!({ agentId: 'a', sessionId: 's', stepName: 'plan' })
      const err = new Error('step blew up')

      // act
      observer.onStepError!({ agentId: 'a', sessionId: 's', stepName: 'plan' }, { error: err, durationMs: 100 })

      // assert
      expect(mockStepSpan.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR, message: 'Error: step blew up' })
      expect(mockStepSpan.end).toHaveBeenCalledOnce()
    })

    it('onStepError is a no-op when no step span is active', () => {
      // arrange
      const mockRootSpan = makeStubSpan()
      const mockTracer = makeStubTracer([mockRootSpan])
      const observer = createOtelObserver(mockTracer)
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'r' })

      // act / assert
      expect(() => observer.onStepError!({ agentId: 'a', sessionId: 's', stepName: 'plan' }, { error: new Error('x'), durationMs: 0 })).not.toThrow()
    })
  })

  // ---- Group 4: Closure reference clearing across repeated calls ----

  describe('closure reference clearing', () => {
    it('second onRunStart without intervening onRunEnd overwrites root span reference', () => {
      // arrange
      const mockRootSpan1 = makeStubSpan()
      const mockRootSpan2 = makeStubSpan()
      const mockTracer = makeStubTracer([mockRootSpan1, mockRootSpan2])
      const observer = createOtelObserver(mockTracer)
      const ctx1 = { agentId: 'a1', sessionId: 's1', runId: 'r1' }
      const ctx2 = { agentId: 'a2', sessionId: 's2', runId: 'r2' }

      // act
      observer.onRunStart!(ctx1)
      observer.onRunStart!(ctx2)

      // assert
      expect(mockTracer.startSpan).toHaveBeenCalledTimes(2)
      expect(mockRootSpan1.end).not.toHaveBeenCalled()
      observer.onRunEnd!(ctx2, { signal: 'done', durationMs: 0 })
      expect(mockRootSpan2.end).toHaveBeenCalledOnce()
    })

    it('Observer is safely reusable across sequential runs', () => {
      // arrange
      const mockRootSpan1 = makeStubSpan()
      const mockRootSpan2 = makeStubSpan()
      const mockTracer = makeStubTracer([mockRootSpan1, mockRootSpan2])
      const observer = createOtelObserver(mockTracer)
      const ctx = { agentId: 'a', sessionId: 's', runId: 'r' }

      // act
      observer.onRunStart!(ctx)
      observer.onRunEnd!(ctx, { signal: 'done', durationMs: 100 })
      observer.onRunStart!(ctx)

      // assert
      expect(mockTracer.startSpan).toHaveBeenCalledTimes(2)
      expect(mockRootSpan1.end).toHaveBeenCalledOnce()
      expect(mockRootSpan2.end).not.toHaveBeenCalled()
    })
  })

  // ---- Group 5: Run lifecycle (onRunEnd and duration histogram) ----

  describe('onRunEnd', () => {
    it('ends root span and records duration histogram in seconds with semconv attribute', () => {
      // arrange
      const mockRootSpan = makeStubSpan()
      const mockDurationHistogram = makeHistogramStub()
      const mockTokenHistogram = makeHistogramStub()
      const mockMeterProvider = makeStubMeterProvider(mockTokenHistogram, mockDurationHistogram)
      const mockTracer = makeStubTracer([mockRootSpan])
      const observer = createOtelObserver(mockTracer, { meterProvider: mockMeterProvider })
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'r' })

      // act
      observer.onRunEnd!({ agentId: 'a', sessionId: 's', runId: 'r' }, { signal: 'done', durationMs: 3000 })

      // assert
      expect(mockRootSpan.end).toHaveBeenCalledOnce()
      expect(mockDurationHistogram.record).toHaveBeenCalledWith(3, { 'gen_ai.operation.name': 'invoke_agent' })
    })

    it('is a no-op when no root span is active — no span end, no histogram recording', () => {
      // arrange
      const mockDurationHistogram = makeHistogramStub()
      const mockTokenHistogram = makeHistogramStub()
      const mockMeterProvider = makeStubMeterProvider(mockTokenHistogram, mockDurationHistogram)
      const mockTracer = makeStubTracer([])
      const observer = createOtelObserver(mockTracer, { meterProvider: mockMeterProvider })

      // act / assert
      expect(() => observer.onRunEnd!({ agentId: 'a', sessionId: 's', runId: 'r' }, { signal: 'done', durationMs: 1000 })).not.toThrow()
      expect(mockDurationHistogram.record).not.toHaveBeenCalled()
    })

    it('ends root span but records no histogram when no meterProvider', () => {
      // arrange
      const mockRootSpan = makeStubSpan()
      const mockTracer = makeStubTracer([mockRootSpan])
      const observer = createOtelObserver(mockTracer)
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'r' })

      // act / assert
      observer.onRunEnd!({ agentId: 'a', sessionId: 's', runId: 'r' }, { signal: 'done', durationMs: 2000 })
      expect(mockRootSpan.end).toHaveBeenCalledOnce()
    })
  })

  // ---- Group 6: Token histogram instrument (gen_ai.client.token.usage) ----

  describe('onEvent — token histogram', () => {
    it('records input and output token counts to histogram with gen_ai.token.type attribute', () => {
      // arrange
      const mockTokenHistogram = makeHistogramStub()
      const mockDurationHistogram = makeHistogramStub()
      const mockMeterProvider = makeStubMeterProvider(mockTokenHistogram, mockDurationHistogram)
      const mockRootSpan = makeStubSpan()
      const mockInferenceSpan = makeStubSpan()
      const mockTracer = makeStubTracer([mockRootSpan, mockInferenceSpan])
      const observer = createOtelObserver(mockTracer, { meterProvider: mockMeterProvider })
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'r' })
      const payload = { modelId: 'gpt-4o', providerName: 'openai', tokens: { input: 42, output: 17 } }

      // act
      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'llm.response', payload)

      // assert
      expect(mockTokenHistogram.record).toHaveBeenCalledWith(42, { 'gen_ai.token.type': 'input' })
      expect(mockTokenHistogram.record).toHaveBeenCalledWith(17, { 'gen_ai.token.type': 'output' })
      expect(mockTokenHistogram.record).toHaveBeenCalledTimes(2)
    })

    it('does not record any metrics when meterProvider is absent and "llm.response" fires', () => {
      // arrange
      const mockRootSpan = makeStubSpan()
      const mockInferenceSpan = makeStubSpan()
      const mockTracer = makeStubTracer([mockRootSpan, mockInferenceSpan])
      const observer = createOtelObserver(mockTracer)
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'r' })
      const payload = { modelId: 'gpt-4o', providerName: 'openai', tokens: { input: 10, output: 5 } }

      // act / assert
      expect(() => observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'llm.response', payload)).not.toThrow()
    })

    it('does not record histogram when tokens fields are missing — no tokens field', () => {
      // arrange
      const mockTokenHistogram = makeHistogramStub()
      const mockDurationHistogram = makeHistogramStub()
      const mockMeterProvider = makeStubMeterProvider(mockTokenHistogram, mockDurationHistogram)
      const mockRootSpan = makeStubSpan()
      const mockInferenceSpan = makeStubSpan()
      const mockTracer = makeStubTracer([mockRootSpan, mockInferenceSpan])
      const observer = createOtelObserver(mockTracer, { meterProvider: mockMeterProvider })
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'r' })

      // act
      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'llm.response', { modelId: 'gpt-4o', providerName: 'openai' })

      // assert
      expect(mockTokenHistogram.record).not.toHaveBeenCalled()
    })

    it('does not record histogram when tokens.input is non-numeric', () => {
      // arrange
      const mockTokenHistogram = makeHistogramStub()
      const mockDurationHistogram = makeHistogramStub()
      const mockMeterProvider = makeStubMeterProvider(mockTokenHistogram, mockDurationHistogram)
      const mockRootSpan = makeStubSpan()
      const mockInferenceSpan = makeStubSpan()
      const mockTracer = makeStubTracer([mockRootSpan, mockInferenceSpan])
      const observer = createOtelObserver(mockTracer, { meterProvider: mockMeterProvider })
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'r' })

      // act
      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'llm.response', { modelId: 'gpt-4o', providerName: 'openai', tokens: { input: 'bad', output: 5 } })

      // assert
      expect(mockTokenHistogram.record).not.toHaveBeenCalled()
    })

    it('does not record histogram when tokens.output is missing', () => {
      // arrange
      const mockTokenHistogram = makeHistogramStub()
      const mockDurationHistogram = makeHistogramStub()
      const mockMeterProvider = makeStubMeterProvider(mockTokenHistogram, mockDurationHistogram)
      const mockRootSpan = makeStubSpan()
      const mockInferenceSpan = makeStubSpan()
      const mockTracer = makeStubTracer([mockRootSpan, mockInferenceSpan])
      const observer = createOtelObserver(mockTracer, { meterProvider: mockMeterProvider })
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'r' })

      // act
      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'llm.response', { modelId: 'gpt-4o', providerName: 'openai', tokens: { input: 10 } })

      // assert
      expect(mockTokenHistogram.record).not.toHaveBeenCalled()
    })
  })

  // ---- Group 7: Tool spans (tool.call and tool.result) ----

  describe('onEvent — tool spans', () => {
    it('"tool.call" creates "execute_tool {toolName}" INTERNAL span with semconv attributes as child of step span', () => {
      // arrange
      const mockRootSpan = makeStubSpan()
      const mockStepSpan = makeStubSpan()
      const mockToolSpan = makeStubSpan()
      const mockTracer = makeStubTracer([mockRootSpan, mockStepSpan, mockToolSpan])
      const toolParentCtx = {} as ReturnType<typeof context.active> // as: sentinel object for identity check
      vi.spyOn(trace, 'setSpan').mockReturnValue(toolParentCtx)
      const observer = createOtelObserver(mockTracer)
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'r' })
      observer.onStepStart!({ agentId: 'a', sessionId: 's', stepName: 'plan' })

      // act
      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'tool.call', { toolName: 'search', toolCallId: 'tc-1' })

      // assert
      expect(mockTracer.startSpan).toHaveBeenCalledWith(
        'execute_tool search',
        { kind: SpanKind.INTERNAL, attributes: { 'gen_ai.tool.name': 'search', 'gen_ai.operation.name': 'execute_tool' } },
        toolParentCtx,
      )
      expect(mockToolSpan.end).not.toHaveBeenCalled()
    })

    it('"tool.call" creates span as child of root span when no step span is active', () => {
      // arrange
      const mockRootSpan = makeStubSpan()
      const mockToolSpan = makeStubSpan()
      const mockTracer = makeStubTracer([mockRootSpan, mockToolSpan])
      const rootParentCtx = {} as ReturnType<typeof context.active> // as: sentinel object for identity check
      vi.spyOn(trace, 'setSpan').mockReturnValue(rootParentCtx)
      const observer = createOtelObserver(mockTracer)
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'r' })

      // act
      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'tool.call', { toolName: 'fetch', toolCallId: 'tc-2' })

      // assert
      expect(mockTracer.startSpan).toHaveBeenCalledWith(
        'execute_tool fetch',
        expect.objectContaining({ attributes: { 'gen_ai.tool.name': 'fetch', 'gen_ai.operation.name': 'execute_tool' } }),
        rootParentCtx,
      )
    })

    it('"tool.result" ends tool span without error status when no error in payload', () => {
      // arrange
      const mockRootSpan = makeStubSpan()
      const mockStepSpan = makeStubSpan()
      const mockToolSpan = makeStubSpan()
      const mockTracer = makeStubTracer([mockRootSpan, mockStepSpan, mockToolSpan])
      const observer = createOtelObserver(mockTracer)
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'r' })
      observer.onStepStart!({ agentId: 'a', sessionId: 's', stepName: 'plan' })
      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'tool.call', { toolName: 'search', toolCallId: 'tc-1' })

      // act
      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'tool.result', { toolCallId: 'tc-1' })

      // assert
      expect(mockToolSpan.end).toHaveBeenCalledOnce()
      expect(mockToolSpan.setStatus).not.toHaveBeenCalled()
      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'tool.result', { toolCallId: 'tc-1' })
      expect(mockToolSpan.end).toHaveBeenCalledOnce()
    })

    it('"tool.result" sets error status and ends tool span when error is set', () => {
      // arrange
      const mockRootSpan = makeStubSpan()
      const mockStepSpan = makeStubSpan()
      const mockToolSpan = makeStubSpan()
      const mockTracer = makeStubTracer([mockRootSpan, mockStepSpan, mockToolSpan])
      const observer = createOtelObserver(mockTracer)
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'r' })
      observer.onStepStart!({ agentId: 'a', sessionId: 's', stepName: 'plan' })
      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'tool.call', { toolName: 'search', toolCallId: 'tc-1' })
      const toolErr = new Error('tool failed')

      // act
      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'tool.result', { toolCallId: 'tc-1', error: toolErr })

      // assert
      expect(mockToolSpan.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR, message: 'Error: tool failed' })
      expect(mockToolSpan.end).toHaveBeenCalledOnce()
    })

    it('"tool.call" is a no-op when neither root nor step span is active', () => {
      // arrange
      const mockTracer = makeStubTracer([])
      const observer = createOtelObserver(mockTracer)

      // act / assert
      expect(() => observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'tool.call', { toolName: 'x', toolCallId: 'tc-1' })).not.toThrow()
      expect(mockTracer.startSpan).not.toHaveBeenCalled()
    })

    it('"tool.result" for unknown toolCallId is a no-op', () => {
      // arrange
      const mockRootSpan = makeStubSpan()
      const mockStepSpan = makeStubSpan()
      const mockToolSpan = makeStubSpan()
      const mockTracer = makeStubTracer([mockRootSpan, mockStepSpan, mockToolSpan])
      const observer = createOtelObserver(mockTracer)
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'r' })
      observer.onStepStart!({ agentId: 'a', sessionId: 's', stepName: 'plan' })
      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'tool.call', { toolName: 'search', toolCallId: 'tc-1' })

      // act / assert
      expect(() => observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'tool.result', { toolCallId: 'tc-UNKNOWN' })).not.toThrow()
    })

    it('second "tool.call" for same toolCallId overwrites old span — subsequent "tool.result" closes new span', () => {
      // arrange
      const mockRootSpan = makeStubSpan()
      const mockStepSpan = makeStubSpan()
      const mockToolSpan1 = makeStubSpan()
      const mockToolSpan2 = makeStubSpan()
      const mockTracer = makeStubTracer([mockRootSpan, mockStepSpan, mockToolSpan1, mockToolSpan2])
      const observer = createOtelObserver(mockTracer)
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'r' })
      observer.onStepStart!({ agentId: 'a', sessionId: 's', stepName: 'plan' })
      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'tool.call', { toolName: 'search', toolCallId: 'tc-dup' })

      // act
      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'tool.call', { toolName: 'search', toolCallId: 'tc-dup' })
      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'tool.result', { toolCallId: 'tc-dup' })

      // assert
      expect(mockToolSpan2.end).toHaveBeenCalledOnce()
      expect(mockToolSpan1.end).not.toHaveBeenCalled()
    })
  })

  // ---- Group 8: Non-reserved event fallback (span.addEvent) ----

  describe('onEvent — non-reserved event fallback', () => {
    it('calls stepSpan.addEvent(type) when step span is active — payload not forwarded', () => {
      // arrange
      const mockRootSpan = makeStubSpan()
      const mockStepSpan = makeStubSpan()
      const mockTracer = makeStubTracer([mockRootSpan, mockStepSpan])
      const observer = createOtelObserver(mockTracer)
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'r' })
      observer.onStepStart!({ agentId: 'a', sessionId: 's', stepName: 'plan' })

      // act
      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'custom.event', { foo: 'bar' })

      // assert
      expect(mockStepSpan.addEvent).toHaveBeenCalledWith('custom.event')
      expect(mockRootSpan.addEvent).not.toHaveBeenCalled()
    })

    it('calls rootSpan.addEvent(type) when only root span is active', () => {
      // arrange
      const mockRootSpan = makeStubSpan()
      const mockTracer = makeStubTracer([mockRootSpan])
      const observer = createOtelObserver(mockTracer)
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'r' })

      // act
      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'custom.event', {})

      // assert
      expect(mockRootSpan.addEvent).toHaveBeenCalledWith('custom.event')
    })

    it('is a no-op when neither span is active', () => {
      // arrange
      const mockTracer = makeStubTracer([])
      const observer = createOtelObserver(mockTracer)

      // act / assert
      expect(() => observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'custom.event', {})).not.toThrow()
    })
  })

  // ---- Group 9: Factory construction and closure isolation ----

  describe('factory construction and closure isolation', () => {
    it('two Observer instances from same factory have independent closure state', () => {
      // arrange
      const mockSpan1 = makeStubSpan()
      const mockSpan2 = makeStubSpan()
      const mockTracer = makeStubTracer([mockSpan1, mockSpan2])
      const observerA = createOtelObserver(mockTracer)
      const observerB = createOtelObserver(mockTracer)
      const ctxA = { agentId: 'a', sessionId: 's1', runId: 'r1' }
      const ctxB = { agentId: 'b', sessionId: 's2', runId: 'r2' }

      // act
      observerA.onRunStart!(ctxA)
      observerB.onRunStart!(ctxB)
      observerA.onRunEnd!(ctxA, { signal: 'done', durationMs: 0 })

      // assert
      expect(mockSpan1.end).toHaveBeenCalledOnce()
      expect(mockSpan2.end).not.toHaveBeenCalled()
    })

    it('Observer with no options uses context.active() and records no metrics', () => {
      // arrange
      const mockRootSpan = makeStubSpan()
      const mockTracer = makeStubTracer([mockRootSpan])
      const activeCtx = {} as ReturnType<typeof context.active> // as: sentinel object for identity check
      vi.spyOn(context, 'active').mockReturnValue(activeCtx)
      const observer = createOtelObserver(mockTracer)
      const ctx = { agentId: 'a', sessionId: 's', runId: 'r' }

      // act
      observer.onRunStart!(ctx)
      observer.onRunEnd!(ctx, { signal: 'done', durationMs: 100 })

      // assert
      expect(mockTracer.startSpan).toHaveBeenCalledWith('invoke_agent a', expect.any(Object), activeCtx)
      expect(mockRootSpan.end).toHaveBeenCalledOnce()
    })

    it('getMeter and both histograms are created once at factory time, not per-run', () => {
      // arrange
      const mockTokenHistogram = makeHistogramStub()
      const mockDurationHistogram = makeHistogramStub()
      const mockMeter = makeStubMeterWithHistograms(mockTokenHistogram, mockDurationHistogram)
      const mockMeterProvider = {
        getMeter: vi.fn().mockReturnValue(mockMeter),
      } as unknown as MeterProvider // as: partial stub
      const mockTracer = makeStubTracer(Array.from({ length: 10 }, () => makeStubSpan()))
      const ctx = { agentId: 'a', sessionId: 's', runId: 'r' }

      // act
      const observer = createOtelObserver(mockTracer, { meterProvider: mockMeterProvider })
      observer.onRunStart!(ctx)
      observer.onRunEnd!(ctx, { signal: 'done', durationMs: 500 })
      observer.onRunStart!(ctx)
      observer.onRunEnd!(ctx, { signal: 'done', durationMs: 500 })

      // assert
      expect(mockMeterProvider.getMeter).toHaveBeenCalledOnce()
      expect(mockMeter.createHistogram).toHaveBeenCalledTimes(2)
      expect(mockMeter.createHistogram).toHaveBeenCalledWith('gen_ai.client.token.usage', { unit: '{token}' })
      expect(mockMeter.createHistogram).toHaveBeenCalledWith('gen_ai.client.operation.duration', { unit: 's' })
    })
  })

  // ---- Group 10: Inference span from "llm.response" events ----

  describe('onEvent — inference span', () => {
    it('creates "chat {modelId}" INTERNAL span as child of step span; sets all attributes; ends immediately', () => {
      // arrange
      const mockRootSpan = makeStubSpan()
      const mockStepSpan = makeStubSpan()
      const mockInferenceSpan = makeStubSpan()
      const mockTracer = makeStubTracer([mockRootSpan, mockStepSpan, mockInferenceSpan])
      const inferenceParentCtx = {} as ReturnType<typeof context.active> // as: sentinel object for identity check
      vi.spyOn(trace, 'setSpan').mockReturnValue(inferenceParentCtx)
      const observer = createOtelObserver(mockTracer)
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'r' })
      observer.onStepStart!({ agentId: 'a', sessionId: 's', stepName: 'plan' })
      const payload = { modelId: 'gpt-4o', providerName: 'openai', tokens: { input: 10, output: 5 }, stopReason: 'stop' }

      // act
      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'llm.response', payload)

      // assert
      expect(mockTracer.startSpan).toHaveBeenCalledWith('chat gpt-4o', { kind: SpanKind.INTERNAL }, inferenceParentCtx)
      expect(mockInferenceSpan.setAttribute).toHaveBeenCalledWith('gen_ai.request.model', 'gpt-4o')
      expect(mockInferenceSpan.setAttribute).toHaveBeenCalledWith('gen_ai.provider.name', 'openai')
      expect(mockInferenceSpan.setAttribute).toHaveBeenCalledWith('gen_ai.usage.input_tokens', 10)
      expect(mockInferenceSpan.setAttribute).toHaveBeenCalledWith('gen_ai.usage.output_tokens', 5)
      expect(mockInferenceSpan.setAttribute).toHaveBeenCalledWith('gen_ai.response.finish_reasons', ['stop'])
      expect(mockInferenceSpan.end).toHaveBeenCalledOnce()
    })

    it('creates inference span as child of root span when no step span is active', () => {
      // arrange
      const mockRootSpan = makeStubSpan()
      const mockInferenceSpan = makeStubSpan()
      const mockTracer = makeStubTracer([mockRootSpan, mockInferenceSpan])
      const rootParentCtx = {} as ReturnType<typeof context.active> // as: sentinel object for identity check
      vi.spyOn(trace, 'setSpan').mockReturnValue(rootParentCtx)
      const observer = createOtelObserver(mockTracer)
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'r' })
      const payload = { modelId: 'gpt-4o', providerName: 'openai', tokens: { input: 10, output: 5 } }

      // act
      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'llm.response', payload)

      // assert
      expect(mockTracer.startSpan).toHaveBeenCalledWith('chat gpt-4o', { kind: SpanKind.INTERNAL }, rootParentCtx)
      expect(mockInferenceSpan.end).toHaveBeenCalledOnce()
    })

    it('no inference span created when neither root nor step span is active', () => {
      // arrange
      const mockTracer = makeStubTracer([])
      const observer = createOtelObserver(mockTracer)
      const payload = { modelId: 'gpt-4o', providerName: 'openai', tokens: { input: 5, output: 5 } }

      // act / assert
      expect(() => observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'llm.response', payload)).not.toThrow()
      expect(mockTracer.startSpan).not.toHaveBeenCalled()
    })

    it('no inference span when modelId is not a string; token histogram still records if valid', () => {
      // arrange
      const mockTokenHistogram = makeHistogramStub()
      const mockDurationHistogram = makeHistogramStub()
      const mockMeterProvider = makeStubMeterProvider(mockTokenHistogram, mockDurationHistogram)
      const mockRootSpan = makeStubSpan()
      const mockTracer = makeStubTracer([mockRootSpan])
      const observer = createOtelObserver(mockTracer, { meterProvider: mockMeterProvider })
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'r' })
      const payload = { modelId: 42, providerName: 'openai', tokens: { input: 10, output: 5 } }

      // act
      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'llm.response', payload)

      // assert
      expect(mockTracer.startSpan).toHaveBeenCalledTimes(1)
      expect(mockTokenHistogram.record).toHaveBeenCalledWith(10, { 'gen_ai.token.type': 'input' })
      expect(mockTokenHistogram.record).toHaveBeenCalledWith(5, { 'gen_ai.token.type': 'output' })
    })

    it('no inference span when providerName is not a string; token histogram still records if valid', () => {
      // arrange
      const mockTokenHistogram = makeHistogramStub()
      const mockDurationHistogram = makeHistogramStub()
      const mockMeterProvider = makeStubMeterProvider(mockTokenHistogram, mockDurationHistogram)
      const mockRootSpan = makeStubSpan()
      const mockTracer = makeStubTracer([mockRootSpan])
      const observer = createOtelObserver(mockTracer, { meterProvider: mockMeterProvider })
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'r' })
      const payload = { modelId: 'gpt-4o', providerName: null, tokens: { input: 7, output: 3 } }

      // act
      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'llm.response', payload)

      // assert
      expect(mockTracer.startSpan).toHaveBeenCalledTimes(1)
      expect(mockTokenHistogram.record).toHaveBeenCalledWith(7, { 'gen_ai.token.type': 'input' })
      expect(mockTokenHistogram.record).toHaveBeenCalledWith(3, { 'gen_ai.token.type': 'output' })
    })

    it('inference span created but token attributes omitted when tokens are absent', () => {
      // arrange
      const mockTokenHistogram = makeHistogramStub()
      const mockDurationHistogram = makeHistogramStub()
      const mockMeterProvider = makeStubMeterProvider(mockTokenHistogram, mockDurationHistogram)
      const mockRootSpan = makeStubSpan()
      const mockInferenceSpan = makeStubSpan()
      const mockTracer = makeStubTracer([mockRootSpan, mockInferenceSpan])
      const observer = createOtelObserver(mockTracer, { meterProvider: mockMeterProvider })
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'r' })
      const payload = { modelId: 'gpt-4o', providerName: 'openai', stopReason: 'stop' }

      // act
      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'llm.response', payload)

      // assert
      expect(mockTracer.startSpan).toHaveBeenCalledTimes(2)
      expect(mockInferenceSpan.setAttribute).toHaveBeenCalledWith('gen_ai.request.model', 'gpt-4o')
      expect(mockInferenceSpan.setAttribute).toHaveBeenCalledWith('gen_ai.provider.name', 'openai')
      expect(mockInferenceSpan.setAttribute).toHaveBeenCalledWith('gen_ai.response.finish_reasons', ['stop'])
      expect(mockInferenceSpan.setAttribute).not.toHaveBeenCalledWith('gen_ai.usage.input_tokens', expect.anything())
      expect(mockInferenceSpan.setAttribute).not.toHaveBeenCalledWith('gen_ai.usage.output_tokens', expect.anything())
      expect(mockTokenHistogram.record).not.toHaveBeenCalled()
      expect(mockInferenceSpan.end).toHaveBeenCalledOnce()
    })

    it('inference span created without gen_ai.response.finish_reasons when stopReason is absent', () => {
      // arrange
      const mockRootSpan = makeStubSpan()
      const mockInferenceSpan = makeStubSpan()
      const mockTracer = makeStubTracer([mockRootSpan, mockInferenceSpan])
      const observer = createOtelObserver(mockTracer)
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'r' })
      const payload = { modelId: 'gpt-4o', providerName: 'openai', tokens: { input: 5, output: 3 } }

      // act
      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'llm.response', payload)

      // assert
      expect(mockInferenceSpan.setAttribute).not.toHaveBeenCalledWith('gen_ai.response.finish_reasons', expect.anything())
      expect(mockInferenceSpan.end).toHaveBeenCalledOnce()
    })

    it('"llm.response" never calls span.addEvent on any active span', () => {
      // arrange
      const mockRootSpan = makeStubSpan()
      const mockStepSpan = makeStubSpan()
      const mockInferenceSpan = makeStubSpan()
      const mockTracer = makeStubTracer([mockRootSpan, mockStepSpan, mockInferenceSpan])
      const observer = createOtelObserver(mockTracer)
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'r' })
      observer.onStepStart!({ agentId: 'a', sessionId: 's', stepName: 'plan' })
      const payload = { modelId: 'gpt-4o', providerName: 'openai', tokens: { input: 5, output: 3 } }

      // act
      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'llm.response', payload)

      // assert
      expect(mockStepSpan.addEvent).not.toHaveBeenCalled()
      expect(mockRootSpan.addEvent).not.toHaveBeenCalled()
      expect(mockInferenceSpan.addEvent).not.toHaveBeenCalled()
    })
  })

  // ---- Group 11: Inference span synchronous end (Invariant 6) ----

  describe('inference span synchronous end', () => {
    it('inference span end() is called synchronously within the same onEvent call', () => {
      // arrange
      const mockRootSpan = makeStubSpan()
      const callOrder: string[] = []
      const mockInferenceSpan = {
        ...makeStubSpan(),
        end: vi.fn().mockImplementation(() => { callOrder.push('inferenceSpan.end') }),
      } as unknown as Span // as: partial stub with call-order tracking
      const mockTracer = makeStubTracer([mockRootSpan, mockInferenceSpan])
      const observer = createOtelObserver(mockTracer)
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'r' })
      const payload = { modelId: 'gpt-4o', providerName: 'openai', tokens: { input: 4, output: 2 } }

      // act
      callOrder.push('onEvent:start')
      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'llm.response', payload)
      callOrder.push('onEvent:end')

      // assert
      expect(callOrder).toEqual(['onEvent:start', 'inferenceSpan.end', 'onEvent:end'])
      expect(mockInferenceSpan.end).toHaveBeenCalledOnce()
    })
  })
})
