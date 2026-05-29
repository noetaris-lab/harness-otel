import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  type Span,
  type Tracer,
  type MeterProvider,
  type Meter,
  type Counter,
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

function makeStubMeterProvider(): {
  meterProvider: MeterProvider
  meter: Meter
  counter: Counter
  histogram: Histogram
} {
  const counter = { add: vi.fn() } as unknown as Counter // as: partial stub — only add is needed
  const histogram = { record: vi.fn() } as unknown as Histogram // as: partial stub — only record is needed
  const meter = {
    createCounter: vi.fn().mockReturnValue(counter),
    createHistogram: vi.fn().mockReturnValue(histogram),
  } as unknown as Meter // as: partial stub — only createCounter/createHistogram are needed
  const meterProvider = {
    getMeter: vi.fn().mockReturnValue(meter),
  } as unknown as MeterProvider // as: partial stub — only getMeter is needed
  return { meterProvider, meter, counter, histogram }
}

// ---- Tests ----

describe('createOtelObserver', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  // ---- Group 1: Root span creation (onRunStart) ----

  describe('onRunStart', () => {
    it('starts "agent.run" span with built-in attributes using context.active() when no options given', () => {
      const stubRootSpan = makeStubSpan()
      const stubTracer = makeStubTracer([stubRootSpan])
      const ACTIVE_CTX = {} as ReturnType<typeof context.active> // as: sentinel object used to verify pass-through identity
      vi.spyOn(context, 'active').mockReturnValue(ACTIVE_CTX)

      const observer = createOtelObserver(stubTracer)
      const runCtx = { agentId: 'agent-1', sessionId: 'session-abc', runId: 'run-1' }

      observer.onRunStart!(runCtx)

      expect(stubTracer.startSpan).toHaveBeenCalledWith(
        'agent.run',
        { attributes: { 'agent.id': 'agent-1', 'session.id': 'session-abc' } },
        ACTIVE_CTX,
      )
      expect(stubTracer.startSpan).toHaveBeenCalledOnce()
    })

    it('starts root span using options.parentContext when provided', () => {
      const stubRootSpan = makeStubSpan()
      const stubTracer = makeStubTracer([stubRootSpan])
      const PARENT_CTX = {} as ReturnType<typeof context.active> // as: sentinel object used to verify pass-through identity

      const observer = createOtelObserver(stubTracer, { parentContext: PARENT_CTX })
      const runCtx = { agentId: 'a', sessionId: 's', runId: 'run-1' }

      observer.onRunStart!(runCtx)

      expect(stubTracer.startSpan).toHaveBeenCalledWith('agent.run', expect.any(Object), PARENT_CTX)
    })

    it('merges options.attributes with built-in attributes', () => {
      const stubRootSpan = makeStubSpan()
      const stubTracer = makeStubTracer([stubRootSpan])

      const observer = createOtelObserver(stubTracer, {
        attributes: { 'service.version': '1.2.3', 'env': 'prod' },
      })
      const runCtx = { agentId: 'a1', sessionId: 's1', runId: 'run-1' }

      observer.onRunStart!(runCtx)

      expect(stubTracer.startSpan).toHaveBeenCalledWith(
        'agent.run',
        {
          attributes: {
            'service.version': '1.2.3',
            'env': 'prod',
            'agent.id': 'a1',
            'session.id': 's1',
          },
        },
        expect.anything(),
      )
    })

    it('built-in attributes take precedence over conflicting options.attributes', () => {
      const stubRootSpan = makeStubSpan()
      const stubTracer = makeStubTracer([stubRootSpan])

      const observer = createOtelObserver(stubTracer, {
        attributes: { 'agent.id': 'OVERRIDE-ME', 'session.id': 'OVERRIDE-ME-TOO', 'extra': 'x' },
      })
      const runCtx = { agentId: 'real-agent', sessionId: 'real-session', runId: 'run-1' }

      observer.onRunStart!(runCtx)

      expect(stubTracer.startSpan).toHaveBeenCalledWith(
        'agent.run',
        {
          attributes: {
            'agent.id': 'real-agent',
            'session.id': 'real-session',
            'extra': 'x',
          },
        },
        expect.anything(),
      )
    })
  })

  // ---- Group 2: Step span creation (onStepStart) ----

  describe('onStepStart', () => {
    it('creates "agent.step" child span with step.name attribute when root span is active', () => {
      const stubRootSpan = makeStubSpan()
      const stubStepSpan = makeStubSpan()
      const stubTracer = makeStubTracer([stubRootSpan, stubStepSpan])
      const CHILD_CTX = {} as ReturnType<typeof context.active> // as: sentinel object used to verify pass-through identity
      vi.spyOn(trace, 'setSpan').mockReturnValue(CHILD_CTX)

      const observer = createOtelObserver(stubTracer)
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'run-1' })

      const stepCtx = { agentId: 'a', sessionId: 's', runId: 'run-1', stepName: 'my-step' }

      observer.onStepStart!(stepCtx)

      expect(trace.setSpan).toHaveBeenCalledWith(expect.anything(), stubRootSpan)
      expect(stubTracer.startSpan).toHaveBeenNthCalledWith(
        2,
        'agent.step',
        { attributes: { 'step.name': 'my-step' } },
        CHILD_CTX,
      )
    })

    it('does not create a step span when no root span is active', () => {
      const stubTracer = makeStubTracer([])

      const observer = createOtelObserver(stubTracer)
      const stepCtx = { agentId: 'a', sessionId: 's', runId: 'run-1', stepName: 'step-x' }

      observer.onStepStart!(stepCtx)

      expect(stubTracer.startSpan).not.toHaveBeenCalled()
    })
  })

  // ---- Group 3: Step span termination (onStepEnd and onStepError) ----

  describe('onStepEnd', () => {
    it('ends step span and clears closure reference when step span is active', () => {
      const stubRootSpan = makeStubSpan()
      const stubStepSpan = makeStubSpan()
      const stubTracer = makeStubTracer([stubRootSpan, stubStepSpan])

      const observer = createOtelObserver(stubTracer)
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'run-1' })
      observer.onStepStart!({ agentId: 'a', sessionId: 's', stepName: 'fetch' })

      const stepCtx = { agentId: 'a', sessionId: 's', runId: 'run-1', stepName: 'fetch' }

      observer.onStepEnd!(stepCtx, { durationMs: 120 })

      expect(stubStepSpan.end).toHaveBeenCalledOnce()

      observer.onStepEnd!(stepCtx, { durationMs: 0 })

      expect(stubStepSpan.end).toHaveBeenCalledOnce()
    })

    it('is a no-op when no step span is active', () => {
      const stubRootSpan = makeStubSpan()
      const stubTracer = makeStubTracer([stubRootSpan])

      const observer = createOtelObserver(stubTracer)
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'run-1' })

      const stepCtx = { agentId: 'a', sessionId: 's', runId: 'run-1', stepName: 'x' }

      observer.onStepEnd!(stepCtx, { durationMs: 50 })

      expect(stubRootSpan.end).not.toHaveBeenCalled()
    })
  })

  describe('onStepError', () => {
    it('sets ERROR status, ends step span, and clears reference when step span is active', () => {
      const stubRootSpan = makeStubSpan()
      const stubStepSpan = makeStubSpan()
      const stubTracer = makeStubTracer([stubRootSpan, stubStepSpan])

      const observer = createOtelObserver(stubTracer)
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'run-1' })
      observer.onStepStart!({ agentId: 'a', sessionId: 's', stepName: 'risky' })

      const testError = new Error('something broke')
      const stepCtx = { agentId: 'a', sessionId: 's', runId: 'run-1', stepName: 'risky' }

      observer.onStepError!(stepCtx, { error: testError, durationMs: 75 })

      expect(stubStepSpan.setStatus).toHaveBeenCalledWith({
        code: SpanStatusCode.ERROR,
        message: 'Error: something broke',
      })
      expect(stubStepSpan.end).toHaveBeenCalledOnce()

      observer.onStepError!(stepCtx, { error: testError, durationMs: 0 })

      expect(stubStepSpan.end).toHaveBeenCalledOnce()
    })

    it('is a no-op when no step span is active', () => {
      const stubRootSpan = makeStubSpan()
      const stubTracer = makeStubTracer([stubRootSpan])

      const observer = createOtelObserver(stubTracer)
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'run-1' })

      const stepCtx = { agentId: 'a', sessionId: 's', runId: 'run-1', stepName: 'x' }

      observer.onStepError!(stepCtx, { error: new Error('e'), durationMs: 10 })

      expect(stubRootSpan.end).not.toHaveBeenCalled()
    })
  })

  // ---- Group 4: Root span termination (onRunEnd) ----

  describe('onRunEnd', () => {
    it('ends root span and clears closure reference when root span is active', () => {
      const stubRootSpan = makeStubSpan()
      const stubTracer = makeStubTracer([stubRootSpan])

      const observer = createOtelObserver(stubTracer)
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'run-1' })

      const runCtx = { agentId: 'a', sessionId: 's', runId: 'run-1' }

      observer.onRunEnd!(runCtx, { signal: 'done', durationMs: 500 })

      expect(stubRootSpan.end).toHaveBeenCalledOnce()

      observer.onRunEnd!(runCtx, { signal: 'done', durationMs: 0 })

      expect(stubRootSpan.end).toHaveBeenCalledOnce()
    })

    it('is a no-op when no root span is active', () => {
      const stubTracer = makeStubTracer([])

      const observer = createOtelObserver(stubTracer)
      const runCtx = { agentId: 'a', sessionId: 's', runId: 'run-1' }

      observer.onRunEnd!(runCtx, { signal: 'done', durationMs: 0 })

      expect(stubTracer.startSpan).not.toHaveBeenCalled()
    })
  })

  // ---- Group 5: Observer reuse and double-start behavior ----

  describe('observer reuse', () => {
    it('second onRunStart without intervening onRunEnd overwrites root span reference', () => {
      const stubRootSpan1 = makeStubSpan()
      const stubRootSpan2 = makeStubSpan()
      const stubTracer = makeStubTracer([stubRootSpan1, stubRootSpan2])

      const observer = createOtelObserver(stubTracer)
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'run-1' })

      observer.onRunStart!({ agentId: 'b', sessionId: 't', runId: 'run-2' })

      expect(stubRootSpan1.end).not.toHaveBeenCalled()

      observer.onRunEnd!({ agentId: 'b', sessionId: 't', runId: 'run-2' }, { signal: 'done', durationMs: 0 })

      expect(stubRootSpan2.end).toHaveBeenCalledOnce()
    })

    it('is safely reusable across sequential runs', () => {
      const stubRootSpan1 = makeStubSpan()
      const stubRootSpan2 = makeStubSpan()
      const stubTracer = makeStubTracer([stubRootSpan1, stubRootSpan2])

      const observer = createOtelObserver(stubTracer)
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'run-1' })
      observer.onRunEnd!({ agentId: 'a', sessionId: 's', runId: 'run-1' }, { signal: 'done', durationMs: 0 })

      observer.onRunStart!({ agentId: 'c', sessionId: 'u', runId: 'run-3' })

      expect(stubTracer.startSpan).toHaveBeenCalledTimes(2)

      observer.onRunEnd!({ agentId: 'c', sessionId: 'u', runId: 'run-3' }, { signal: 'done', durationMs: 0 })

      expect(stubRootSpan2.end).toHaveBeenCalledOnce()
    })
  })

  // ---- Group 6: Token counter metrics (onEvent with "llm.response") ----

  describe('onEvent — llm.response', () => {
    it('records input and output token counter adds for valid "llm.response" payload', () => {
      const { meterProvider, counter } = makeStubMeterProvider()
      const stubRootSpan = makeStubSpan()
      const stubTracer = makeStubTracer([stubRootSpan])

      const observer = createOtelObserver(stubTracer, { meterProvider })
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'run-1' })

      const payload = { tokens: { input: 300, output: 150 } }

      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 'llm' }, 'llm.response', payload)

      expect(counter.add).toHaveBeenCalledTimes(2)
      expect(counter.add).toHaveBeenCalledWith(300, { 'token.type': 'input' })
      expect(counter.add).toHaveBeenCalledWith(150, { 'token.type': 'output' })
    })

    it('does not call counter when meterProvider was not provided', () => {
      const stubRootSpan = makeStubSpan()
      const stubTracer = makeStubTracer([stubRootSpan])

      const observer = createOtelObserver(stubTracer)
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'run-1' })

      const payload = { tokens: { input: 100, output: 50 } }

      expect(() => {
        observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 'llm' }, 'llm.response', payload)
      }).not.toThrow()
    })

    it('skips counter.add when tokens field is missing or malformed', () => {
      const { meterProvider, counter } = makeStubMeterProvider()
      const stubRootSpan = makeStubSpan()
      const stubTracer = makeStubTracer([stubRootSpan])

      const observer = createOtelObserver(stubTracer, { meterProvider })
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'run-1' })

      const evtCtx = { agentId: 'a', sessionId: 's', stepName: 'llm' }

      observer.onEvent!(evtCtx, 'llm.response', {})
      observer.onEvent!(evtCtx, 'llm.response', { tokens: null })
      observer.onEvent!(evtCtx, 'llm.response', { tokens: { input: 'not-a-number', output: 50 } })

      expect(counter.add).not.toHaveBeenCalled()
    })

    it('"llm.response" events do not call span.addEvent on any active span', () => {
      const stubRootSpan = makeStubSpan()
      const stubStepSpan = makeStubSpan()
      const stubTracer = makeStubTracer([stubRootSpan, stubStepSpan])
      const { meterProvider } = makeStubMeterProvider()

      const observer = createOtelObserver(stubTracer, { meterProvider })
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'run-1' })
      observer.onStepStart!({ agentId: 'a', sessionId: 's', stepName: 'llm-step' })

      const payload = { tokens: { input: 10, output: 5 } }

      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 'llm-step' }, 'llm.response', payload)

      expect(stubStepSpan.addEvent).not.toHaveBeenCalled()
      expect(stubRootSpan.addEvent).not.toHaveBeenCalled()
    })
  })

  // ---- Group 7: Step duration histogram metrics ----

  describe('histogram — onStepEnd and onStepError', () => {
    it('onStepEnd records step duration to histogram when meterProvider is provided', () => {
      const { meterProvider, histogram } = makeStubMeterProvider()
      const stubRootSpan = makeStubSpan()
      const stubStepSpan = makeStubSpan()
      const stubTracer = makeStubTracer([stubRootSpan, stubStepSpan])

      const observer = createOtelObserver(stubTracer, { meterProvider })
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'run-1' })
      observer.onStepStart!({ agentId: 'a', sessionId: 's', stepName: 'embed' })

      const stepCtx = { agentId: 'a', sessionId: 's', runId: 'run-1', stepName: 'embed' }

      observer.onStepEnd!(stepCtx, { durationMs: 250 })

      expect(histogram.record).toHaveBeenCalledWith(250, { 'step.name': 'embed' })
      expect(stubStepSpan.end).toHaveBeenCalledOnce()
    })

    it('onStepEnd does not record histogram and still ends span when meterProvider absent', () => {
      const stubRootSpan = makeStubSpan()
      const stubStepSpan = makeStubSpan()
      const stubTracer = makeStubTracer([stubRootSpan, stubStepSpan])

      const observer = createOtelObserver(stubTracer)
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'run-1' })
      observer.onStepStart!({ agentId: 'a', sessionId: 's', stepName: 'search' })

      const stepCtx = { agentId: 'a', sessionId: 's', runId: 'run-1', stepName: 'search' }

      observer.onStepEnd!(stepCtx, { durationMs: 80 })

      expect(stubStepSpan.end).toHaveBeenCalledOnce()
    })

    it('onStepError records step duration to histogram when meterProvider is provided', () => {
      const { meterProvider, histogram } = makeStubMeterProvider()
      const stubRootSpan = makeStubSpan()
      const stubStepSpan = makeStubSpan()
      const stubTracer = makeStubTracer([stubRootSpan, stubStepSpan])

      const observer = createOtelObserver(stubTracer, { meterProvider })
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'run-1' })
      observer.onStepStart!({ agentId: 'a', sessionId: 's', stepName: 'parse' })

      const stepCtx = { agentId: 'a', sessionId: 's', runId: 'run-1', stepName: 'parse' }
      const testError = new Error('fail')

      observer.onStepError!(stepCtx, { error: testError, durationMs: 33 })

      expect(histogram.record).toHaveBeenCalledWith(33, { 'step.name': 'parse' })
      expect(stubStepSpan.end).toHaveBeenCalledOnce()
    })

    it('onStepError does not record histogram and still sets status and ends span when meterProvider absent', () => {
      const stubRootSpan = makeStubSpan()
      const stubStepSpan = makeStubSpan()
      const stubTracer = makeStubTracer([stubRootSpan, stubStepSpan])

      const observer = createOtelObserver(stubTracer)
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'run-1' })
      observer.onStepStart!({ agentId: 'a', sessionId: 's', stepName: 'validate' })

      const stepCtx = { agentId: 'a', sessionId: 's', runId: 'run-1', stepName: 'validate' }
      const testError = new Error('boom')

      observer.onStepError!(stepCtx, { error: testError, durationMs: 15 })

      expect(stubStepSpan.setStatus).toHaveBeenCalledOnce()
      expect(stubStepSpan.end).toHaveBeenCalledOnce()
    })
  })

  // ---- Group 8: onEvent non-"llm.response" routing ----

  describe('onEvent — non-llm.response', () => {
    it('calls stepSpan.addEvent(type) when step span is active', () => {
      const stubRootSpan = makeStubSpan()
      const stubStepSpan = makeStubSpan()
      const stubTracer = makeStubTracer([stubRootSpan, stubStepSpan])

      const observer = createOtelObserver(stubTracer)
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'run-1' })
      observer.onStepStart!({ agentId: 'a', sessionId: 's', stepName: 'tool-call' })

      const evtCtx = { agentId: 'a', sessionId: 's', stepName: 'tool-call' }

      observer.onEvent!(evtCtx, 'step.progress', { data: 'something' })

      expect(stubStepSpan.addEvent).toHaveBeenCalledWith('step.progress')
      expect(stubRootSpan.addEvent).not.toHaveBeenCalled()
    })

    it('calls rootSpan.addEvent(type) when only root span is active', () => {
      const stubRootSpan = makeStubSpan()
      const stubTracer = makeStubTracer([stubRootSpan])

      const observer = createOtelObserver(stubTracer)
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'run-1' })

      const evtCtx = { agentId: 'a', sessionId: 's', stepName: 'x' }

      observer.onEvent!(evtCtx, 'custom.event', { x: 1 })

      expect(stubRootSpan.addEvent).toHaveBeenCalledWith('custom.event')
    })

    it('is a no-op when neither step span nor root span is active', () => {
      const stubTracer = makeStubTracer([])

      const observer = createOtelObserver(stubTracer)
      const evtCtx = { agentId: 'a', sessionId: 's', stepName: 'x' }

      expect(() => {
        observer.onEvent!(evtCtx, 'some.event', {})
      }).not.toThrow()

      expect(stubTracer.startSpan).not.toHaveBeenCalled()
    })
  })

  // ---- Group 9: Factory isolation and defaults ----

  describe('factory isolation and defaults', () => {
    it('two Observer instances maintain independent closure state', () => {
      const stubRootSpan1 = makeStubSpan()
      const stubRootSpan2 = makeStubSpan()
      const stubTracer = makeStubTracer([stubRootSpan1, stubRootSpan2])

      const observer1 = createOtelObserver(stubTracer)
      const observer2 = createOtelObserver(stubTracer)

      observer1.onRunStart!({ agentId: 'a1', sessionId: 's1', runId: 'run-1' })
      observer2.onRunStart!({ agentId: 'a2', sessionId: 's2', runId: 'run-2' })

      observer1.onRunEnd!({ agentId: 'a1', sessionId: 's1', runId: 'run-1' }, { signal: 'done', durationMs: 0 })

      expect(stubRootSpan1.end).toHaveBeenCalledOnce()
      expect(stubRootSpan2.end).not.toHaveBeenCalled()
    })

    it('no options — no metrics recorded and spans use context.active() as parent', () => {
      const stubRootSpan = makeStubSpan()
      const stubTracer = makeStubTracer([stubRootSpan])
      const ACTIVE_CTX = {} as ReturnType<typeof context.active> // as: sentinel object used to verify pass-through identity
      vi.spyOn(context, 'active').mockReturnValue(ACTIVE_CTX)

      const observer = createOtelObserver(stubTracer)
      const runCtx = { agentId: 'x', sessionId: 'y', runId: 'run-1' }

      observer.onRunStart!(runCtx)

      expect(stubTracer.startSpan).toHaveBeenCalledWith('agent.run', expect.any(Object), ACTIVE_CTX)

      expect(() => {
        observer.onEvent!(
          { agentId: 'x', sessionId: 'y', stepName: 'llm' },
          'llm.response',
          { tokens: { input: 1, output: 1 } },
        )
      }).not.toThrow()
    })

    it('instruments are created exactly once regardless of how many onEvent calls are made', () => {
      const { meterProvider, meter, counter } = makeStubMeterProvider()
      const stubRootSpan = makeStubSpan()
      const stubTracer = makeStubTracer([stubRootSpan])

      const observer = createOtelObserver(stubTracer, { meterProvider })
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'run-1' })

      const payload = { tokens: { input: 10, output: 5 } }
      const evtCtx = { agentId: 'a', sessionId: 's', stepName: 'llm' }

      observer.onEvent!(evtCtx, 'llm.response', payload)
      observer.onEvent!(evtCtx, 'llm.response', payload)
      observer.onEvent!(evtCtx, 'llm.response', payload)

      expect(meterProvider.getMeter).toHaveBeenCalledOnce()
      expect(meter.createCounter).toHaveBeenCalledOnce()
      expect(meter.createHistogram).toHaveBeenCalledOnce()
      expect(counter.add).toHaveBeenCalledTimes(6)
    })
  })

  // ---- Group 1: "tool.call" span creation — valid payload ----

  describe('onEvent — tool.call (valid payload)', () => {
    it('starts "execute_tool {toolName}" INTERNAL span as child of step span', () => {
      const stubRootSpan = makeStubSpan()
      const stubStepSpan = makeStubSpan()
      const stubToolSpan = makeStubSpan()
      const stubTracer = makeStubTracer([stubRootSpan, stubStepSpan, stubToolSpan])
      const STEP_CHILD_CTX = {} as ReturnType<typeof context.active> // as: sentinel object used to verify pass-through identity
      vi.spyOn(trace, 'setSpan').mockReturnValue(STEP_CHILD_CTX)

      const observer = createOtelObserver(stubTracer)
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'run-1' })
      observer.onStepStart!({ agentId: 'a', sessionId: 's', stepName: 'my-step' })

      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 'my-step' }, 'tool.call', {
        toolName: 'search',
        toolCallId: 'call-1',
      })

      expect(trace.setSpan).toHaveBeenCalledWith(expect.anything(), stubStepSpan)
      expect(stubTracer.startSpan).toHaveBeenNthCalledWith(
        3,
        'execute_tool search',
        { kind: SpanKind.INTERNAL, attributes: { 'gen_ai.tool.name': 'search', 'gen_ai.operation.name': 'execute_tool' } },
        STEP_CHILD_CTX,
      )
    })

    it('span stored in toolSpans under toolCallId and closed by matching "tool.result"', () => {
      const stubRootSpan = makeStubSpan()
      const stubStepSpan = makeStubSpan()
      const stubToolSpan = makeStubSpan()
      const stubTracer = makeStubTracer([stubRootSpan, stubStepSpan, stubToolSpan])

      const observer = createOtelObserver(stubTracer)
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'run-1' })
      observer.onStepStart!({ agentId: 'a', sessionId: 's', stepName: 's' })

      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'tool.call', {
        toolName: 'search',
        toolCallId: 'call-1',
      })
      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'tool.result', {
        toolName: 'search',
        toolCallId: 'call-1',
        durationMs: 10,
      })

      expect(stubToolSpan.end).toHaveBeenCalledOnce()
      expect(stubRootSpan.end).not.toHaveBeenCalled()
      expect(stubStepSpan.end).not.toHaveBeenCalled()
    })
  })

  // ---- Group 2: "tool.call" guard — malformed payload fields ----

  describe('onEvent — tool.call (guards)', () => {
    it('ignores "tool.call" when toolName is not a string', () => {
      const stubRootSpan = makeStubSpan()
      const stubStepSpan = makeStubSpan()
      const stubTracer = makeStubTracer([stubRootSpan, stubStepSpan])

      const observer = createOtelObserver(stubTracer)
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'run-1' })
      observer.onStepStart!({ agentId: 'a', sessionId: 's', stepName: 's' })

      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'tool.call', {
        toolName: 42,
        toolCallId: 'call-1',
      })

      expect(stubTracer.startSpan).toHaveBeenCalledTimes(2)
    })

    it('ignores "tool.call" when toolCallId is not a string', () => {
      const stubRootSpan = makeStubSpan()
      const stubStepSpan = makeStubSpan()
      const stubTracer = makeStubTracer([stubRootSpan, stubStepSpan])

      const observer = createOtelObserver(stubTracer)
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'run-1' })
      observer.onStepStart!({ agentId: 'a', sessionId: 's', stepName: 's' })

      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'tool.call', {
        toolName: 'search',
        toolCallId: undefined,
      })

      expect(stubTracer.startSpan).toHaveBeenCalledTimes(2)
    })
  })

  // ---- Group 3: "tool.call" parent span fallback and no-span guard ----

  describe('onEvent — tool.call (parent span fallback)', () => {
    it('uses root span as parent when step span is not active', () => {
      const stubRootSpan = makeStubSpan()
      const stubToolSpan = makeStubSpan()
      const stubTracer = makeStubTracer([stubRootSpan, stubToolSpan])
      const ROOT_CHILD_CTX = {} as ReturnType<typeof context.active> // as: sentinel object used to verify pass-through identity
      vi.spyOn(trace, 'setSpan').mockReturnValue(ROOT_CHILD_CTX)

      const observer = createOtelObserver(stubTracer)
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'run-1' })

      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 'x' }, 'tool.call', {
        toolName: 'search',
        toolCallId: 'call-1',
      })

      expect(trace.setSpan).toHaveBeenCalledWith(expect.anything(), stubRootSpan)
      expect(stubTracer.startSpan).toHaveBeenNthCalledWith(
        2,
        'execute_tool search',
        expect.objectContaining({ kind: SpanKind.INTERNAL }),
        ROOT_CHILD_CTX,
      )
    })

    it('is a no-op when neither step span nor root span is active', () => {
      const stubTracer = makeStubTracer([])

      const observer = createOtelObserver(stubTracer)

      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 'x' }, 'tool.call', {
        toolName: 'search',
        toolCallId: 'call-1',
      })

      expect(stubTracer.startSpan).not.toHaveBeenCalled()
    })
  })

  // ---- Group 4: duplicate "tool.call" for same toolCallId ----

  describe('onEvent — tool.call (duplicate toolCallId)', () => {
    it('second "tool.call" for same toolCallId overwrites map entry; new span is closed by subsequent "tool.result"', () => {
      const stubRootSpan = makeStubSpan()
      const stubStepSpan = makeStubSpan()
      const stubToolSpan1 = makeStubSpan()
      const stubToolSpan2 = makeStubSpan()
      const stubTracer = makeStubTracer([stubRootSpan, stubStepSpan, stubToolSpan1, stubToolSpan2])

      const observer = createOtelObserver(stubTracer)
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'run-1' })
      observer.onStepStart!({ agentId: 'a', sessionId: 's', stepName: 's' })

      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'tool.call', {
        toolName: 'search',
        toolCallId: 'call-1',
      })
      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'tool.call', {
        toolName: 'search',
        toolCallId: 'call-1',
      })
      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'tool.result', {
        toolName: 'search',
        toolCallId: 'call-1',
        durationMs: 5,
      })

      expect(stubToolSpan2.end).toHaveBeenCalledOnce()
      expect(stubToolSpan1.end).not.toHaveBeenCalled()
    })
  })

  // ---- Group 5: "tool.result" span close — success path ----

  describe('onEvent — tool.result (success path)', () => {
    it('ends tool span with no status change when error field is absent', () => {
      const stubRootSpan = makeStubSpan()
      const stubStepSpan = makeStubSpan()
      const stubToolSpan = makeStubSpan()
      const stubTracer = makeStubTracer([stubRootSpan, stubStepSpan, stubToolSpan])

      const observer = createOtelObserver(stubTracer)
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'run-1' })
      observer.onStepStart!({ agentId: 'a', sessionId: 's', stepName: 's' })
      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'tool.call', {
        toolName: 'search',
        toolCallId: 'call-1',
      })

      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'tool.result', {
        toolName: 'search',
        toolCallId: 'call-1',
        durationMs: 42,
      })

      expect(stubToolSpan.setStatus).not.toHaveBeenCalled()
      expect(stubToolSpan.end).toHaveBeenCalledOnce()
    })

    it('ends tool span with no error status when error is explicitly undefined', () => {
      const stubRootSpan = makeStubSpan()
      const stubStepSpan = makeStubSpan()
      const stubToolSpan = makeStubSpan()
      const stubTracer = makeStubTracer([stubRootSpan, stubStepSpan, stubToolSpan])

      const observer = createOtelObserver(stubTracer)
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'run-1' })
      observer.onStepStart!({ agentId: 'a', sessionId: 's', stepName: 's' })
      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'tool.call', {
        toolName: 'search',
        toolCallId: 'call-1',
      })

      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'tool.result', {
        toolName: 'search',
        toolCallId: 'call-1',
        durationMs: 42,
        error: undefined,
      })

      expect(stubToolSpan.setStatus).not.toHaveBeenCalled()
      expect(stubToolSpan.end).toHaveBeenCalledOnce()
    })

    it('map entry is removed after "tool.result" — second result for same toolCallId is a no-op', () => {
      const stubRootSpan = makeStubSpan()
      const stubStepSpan = makeStubSpan()
      const stubToolSpan = makeStubSpan()
      const stubTracer = makeStubTracer([stubRootSpan, stubStepSpan, stubToolSpan])

      const observer = createOtelObserver(stubTracer)
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'run-1' })
      observer.onStepStart!({ agentId: 'a', sessionId: 's', stepName: 's' })
      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'tool.call', {
        toolName: 'search',
        toolCallId: 'call-1',
      })
      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'tool.result', {
        toolName: 'search',
        toolCallId: 'call-1',
        durationMs: 10,
      })

      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'tool.result', {
        toolName: 'search',
        toolCallId: 'call-1',
        durationMs: 10,
      })

      expect(stubToolSpan.end).toHaveBeenCalledOnce()
    })
  })

  // ---- Group 6: "tool.result" span close — error path ----

  describe('onEvent — tool.result (error path)', () => {
    it('sets SpanStatusCode.ERROR with String(error) message and ends span when error is an Error instance', () => {
      const stubRootSpan = makeStubSpan()
      const stubStepSpan = makeStubSpan()
      const stubToolSpan = makeStubSpan()
      const stubTracer = makeStubTracer([stubRootSpan, stubStepSpan, stubToolSpan])

      const observer = createOtelObserver(stubTracer)
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'run-1' })
      observer.onStepStart!({ agentId: 'a', sessionId: 's', stepName: 's' })
      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'tool.call', {
        toolName: 'search',
        toolCallId: 'call-1',
      })
      const testError = new Error('not found')

      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'tool.result', {
        toolName: 'search',
        toolCallId: 'call-1',
        durationMs: 5,
        error: testError,
      })

      expect(stubToolSpan.setStatus).toHaveBeenCalledWith({
        code: SpanStatusCode.ERROR,
        message: 'Error: not found',
      })
      expect(stubToolSpan.end).toHaveBeenCalledOnce()
    })

    it('coerces non-Error error value to string via String() in the status message', () => {
      const stubRootSpan = makeStubSpan()
      const stubStepSpan = makeStubSpan()
      const stubToolSpan = makeStubSpan()
      const stubTracer = makeStubTracer([stubRootSpan, stubStepSpan, stubToolSpan])

      const observer = createOtelObserver(stubTracer)
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'run-1' })
      observer.onStepStart!({ agentId: 'a', sessionId: 's', stepName: 's' })
      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'tool.call', {
        toolName: 'search',
        toolCallId: 'call-1',
      })

      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'tool.result', {
        toolName: 'search',
        toolCallId: 'call-1',
        durationMs: 5,
        error: 'timeout',
      })

      expect(stubToolSpan.setStatus).toHaveBeenCalledWith({
        code: SpanStatusCode.ERROR,
        message: 'timeout',
      })
      expect(stubToolSpan.end).toHaveBeenCalledOnce()
    })
  })

  // ---- Group 7: "tool.result" for unknown or malformed toolCallId ----

  describe('onEvent — tool.result (unknown or malformed toolCallId)', () => {
    it('"tool.result" for an unknown toolCallId is a no-op', () => {
      const stubRootSpan = makeStubSpan()
      const stubStepSpan = makeStubSpan()
      const stubTracer = makeStubTracer([stubRootSpan, stubStepSpan])

      const observer = createOtelObserver(stubTracer)
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'run-1' })
      observer.onStepStart!({ agentId: 'a', sessionId: 's', stepName: 's' })

      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'tool.result', {
        toolName: 'search',
        toolCallId: 'call-x',
        durationMs: 10,
      })

      expect(stubRootSpan.end).not.toHaveBeenCalled()
      expect(stubStepSpan.end).not.toHaveBeenCalled()
    })

    it('"tool.result" with non-string toolCallId is a no-op', () => {
      const stubRootSpan = makeStubSpan()
      const stubStepSpan = makeStubSpan()
      const stubToolSpan = makeStubSpan()
      const stubTracer = makeStubTracer([stubRootSpan, stubStepSpan, stubToolSpan])

      const observer = createOtelObserver(stubTracer)
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'run-1' })
      observer.onStepStart!({ agentId: 'a', sessionId: 's', stepName: 's' })
      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'tool.call', {
        toolName: 'search',
        toolCallId: 'call-1',
      })

      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'tool.result', {
        toolName: 'search',
        toolCallId: 99,
        durationMs: 5,
      })

      expect(stubToolSpan.end).not.toHaveBeenCalled()
    })
  })

  // ---- Group 8: guard behavior for null payloads ----

  describe('onEvent — tool.call and tool.result (null payloads)', () => {
    it('"tool.call" with null payload does not throw and creates no span', () => {
      const stubRootSpan = makeStubSpan()
      const stubStepSpan = makeStubSpan()
      const stubTracer = makeStubTracer([stubRootSpan, stubStepSpan])

      const observer = createOtelObserver(stubTracer)
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'run-1' })
      observer.onStepStart!({ agentId: 'a', sessionId: 's', stepName: 's' })

      expect(() => {
        observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'tool.call', null)
      }).not.toThrow()

      expect(stubTracer.startSpan).toHaveBeenCalledTimes(2)
    })

    it('"tool.result" with null payload does not throw', () => {
      const stubRootSpan = makeStubSpan()
      const stubStepSpan = makeStubSpan()
      const stubToolSpan = makeStubSpan()
      const stubTracer = makeStubTracer([stubRootSpan, stubStepSpan, stubToolSpan])

      const observer = createOtelObserver(stubTracer)
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'run-1' })
      observer.onStepStart!({ agentId: 'a', sessionId: 's', stepName: 's' })
      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'tool.call', {
        toolName: 'search',
        toolCallId: 'call-1',
      })

      expect(() => {
        observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'tool.result', null)
      }).not.toThrow()

      expect(stubToolSpan.end).not.toHaveBeenCalled()
    })
  })

  // ---- Group 9: concurrent and interleaved tool spans ----

  describe('onEvent — concurrent tool spans', () => {
    it('two concurrent tool spans with distinct toolCallIds close independently in sequence', () => {
      const stubRootSpan = makeStubSpan()
      const stubStepSpan = makeStubSpan()
      const stubToolSpan1 = makeStubSpan()
      const stubToolSpan2 = makeStubSpan()
      const stubTracer = makeStubTracer([stubRootSpan, stubStepSpan, stubToolSpan1, stubToolSpan2])

      const observer = createOtelObserver(stubTracer)
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'run-1' })
      observer.onStepStart!({ agentId: 'a', sessionId: 's', stepName: 's' })

      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'tool.call', {
        toolName: 'search',
        toolCallId: 'call-1',
      })
      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'tool.call', {
        toolName: 'lookup',
        toolCallId: 'call-2',
      })

      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'tool.result', {
        toolName: 'search',
        toolCallId: 'call-1',
        durationMs: 20,
      })

      expect(stubToolSpan1.end).toHaveBeenCalledOnce()
      expect(stubToolSpan2.end).not.toHaveBeenCalled()

      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'tool.result', {
        toolName: 'lookup',
        toolCallId: 'call-2',
        durationMs: 30,
      })

      expect(stubToolSpan2.end).toHaveBeenCalledOnce()
    })

    it('onStepEnd with open tool spans does not close those spans; subsequent "tool.result" still closes them', () => {
      const stubRootSpan = makeStubSpan()
      const stubStepSpan = makeStubSpan()
      const stubToolSpan = makeStubSpan()
      const stubTracer = makeStubTracer([stubRootSpan, stubStepSpan, stubToolSpan])

      const observer = createOtelObserver(stubTracer)
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'run-1' })
      observer.onStepStart!({ agentId: 'a', sessionId: 's', stepName: 's' })
      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'tool.call', {
        toolName: 'search',
        toolCallId: 'call-1',
      })

      observer.onStepEnd!({ agentId: 'a', sessionId: 's', stepName: 's' }, { durationMs: 100 })

      expect(stubToolSpan.end).not.toHaveBeenCalled()

      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'tool.result', {
        toolName: 'search',
        toolCallId: 'call-1',
        durationMs: 5,
      })

      expect(stubToolSpan.end).toHaveBeenCalledOnce()
    })
  })

  // ---- Group 10: interaction with existing event routing ----

  describe('onEvent — interaction with existing routing', () => {
    it('"tool.call" does not call addEvent on any active span', () => {
      const stubRootSpan = makeStubSpan()
      const stubStepSpan = makeStubSpan()
      const stubToolSpan = makeStubSpan()
      const stubTracer = makeStubTracer([stubRootSpan, stubStepSpan, stubToolSpan])

      const observer = createOtelObserver(stubTracer)
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'run-1' })
      observer.onStepStart!({ agentId: 'a', sessionId: 's', stepName: 's' })

      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'tool.call', {
        toolName: 'search',
        toolCallId: 'call-1',
      })

      expect(stubStepSpan.addEvent).not.toHaveBeenCalled()
      expect(stubRootSpan.addEvent).not.toHaveBeenCalled()
    })

    it('"tool.result" does not call addEvent on any active span', () => {
      const stubRootSpan = makeStubSpan()
      const stubStepSpan = makeStubSpan()
      const stubToolSpan = makeStubSpan()
      const stubTracer = makeStubTracer([stubRootSpan, stubStepSpan, stubToolSpan])

      const observer = createOtelObserver(stubTracer)
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'run-1' })
      observer.onStepStart!({ agentId: 'a', sessionId: 's', stepName: 's' })
      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'tool.call', {
        toolName: 'search',
        toolCallId: 'call-1',
      })

      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'tool.result', {
        toolName: 'search',
        toolCallId: 'call-1',
        durationMs: 5,
      })

      expect(stubStepSpan.addEvent).not.toHaveBeenCalled()
      expect(stubRootSpan.addEvent).not.toHaveBeenCalled()
    })

    it('unknown event types still call activeSpan.addEvent (existing fallthrough preserved)', () => {
      const stubRootSpan = makeStubSpan()
      const stubStepSpan = makeStubSpan()
      const stubTracer = makeStubTracer([stubRootSpan, stubStepSpan])

      const observer = createOtelObserver(stubTracer)
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'run-1' })
      observer.onStepStart!({ agentId: 'a', sessionId: 's', stepName: 's' })

      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'custom.event', { x: 1 })

      expect(stubStepSpan.addEvent).toHaveBeenCalledWith('custom.event')
      expect(stubRootSpan.addEvent).not.toHaveBeenCalled()
    })

    it('"llm.response" token metrics still recorded correctly after tool span changes', () => {
      const { meterProvider, counter } = makeStubMeterProvider()
      const stubRootSpan = makeStubSpan()
      const stubStepSpan = makeStubSpan()
      const stubTracer = makeStubTracer([stubRootSpan, stubStepSpan])

      const observer = createOtelObserver(stubTracer, { meterProvider })
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'run-1' })
      observer.onStepStart!({ agentId: 'a', sessionId: 's', stepName: 'llm' })

      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 'llm' }, 'llm.response', {
        tokens: { input: 200, output: 100 },
      })

      expect(counter.add).toHaveBeenCalledTimes(2)
      expect(counter.add).toHaveBeenCalledWith(200, { 'token.type': 'input' })
      expect(counter.add).toHaveBeenCalledWith(100, { 'token.type': 'output' })
    })
  })

  // ---- Group 11: closure isolation between observer instances ----

  describe('onEvent — closure isolation (toolSpans)', () => {
    it('two observer instances maintain independent toolSpans maps', () => {
      const stubRootSpan1 = makeStubSpan()
      const stubStepSpan1 = makeStubSpan()
      const stubToolSpanA = makeStubSpan()
      const stubRootSpan2 = makeStubSpan()
      const stubStepSpan2 = makeStubSpan()
      const stubToolSpanB = makeStubSpan()
      const stubTracer1 = makeStubTracer([stubRootSpan1, stubStepSpan1, stubToolSpanA])
      const stubTracer2 = makeStubTracer([stubRootSpan2, stubStepSpan2, stubToolSpanB])

      const observerA = createOtelObserver(stubTracer1)
      const observerB = createOtelObserver(stubTracer2)

      observerA.onRunStart!({ agentId: 'a', sessionId: 's1', runId: 'run-1' })
      observerA.onStepStart!({ agentId: 'a', sessionId: 's1', stepName: 's1' })
      observerB.onRunStart!({ agentId: 'b', sessionId: 's2', runId: 'run-2' })
      observerB.onStepStart!({ agentId: 'b', sessionId: 's2', stepName: 's2' })

      observerA.onEvent!({ agentId: 'a', sessionId: 's1', stepName: 's1' }, 'tool.call', {
        toolName: 'x',
        toolCallId: 'call-1',
      })
      observerB.onEvent!({ agentId: 'b', sessionId: 's2', stepName: 's2' }, 'tool.call', {
        toolName: 'y',
        toolCallId: 'call-1',
      })

      observerA.onEvent!({ agentId: 'a', sessionId: 's1', stepName: 's1' }, 'tool.result', {
        toolName: 'x',
        toolCallId: 'call-1',
        durationMs: 5,
      })

      expect(stubToolSpanA.end).toHaveBeenCalledOnce()
      expect(stubToolSpanB.end).not.toHaveBeenCalled()
    })
  })

  // ---- Group 12: onRunEnd cleanup ----

  describe('onEvent — onRunEnd with open tool spans', () => {
    it('onRunEnd ends root span normally when tool spans remain open; does not throw', () => {
      const stubRootSpan = makeStubSpan()
      const stubStepSpan = makeStubSpan()
      const stubToolSpan = makeStubSpan()
      const stubTracer = makeStubTracer([stubRootSpan, stubStepSpan, stubToolSpan])

      const observer = createOtelObserver(stubTracer)
      observer.onRunStart!({ agentId: 'a', sessionId: 's', runId: 'run-1' })
      observer.onStepStart!({ agentId: 'a', sessionId: 's', stepName: 's' })
      observer.onEvent!({ agentId: 'a', sessionId: 's', stepName: 's' }, 'tool.call', {
        toolName: 'search',
        toolCallId: 'call-1',
      })
      observer.onStepEnd!({ agentId: 'a', sessionId: 's', stepName: 's' }, { durationMs: 100 })

      observer.onRunEnd!({ agentId: 'a', sessionId: 's', runId: 'run-1' }, { signal: 'done', durationMs: 500 })

      expect(stubRootSpan.end).toHaveBeenCalledOnce()
      expect(stubToolSpan.end).not.toHaveBeenCalled()
    })
  })
})
