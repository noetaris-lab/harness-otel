# @noetaris/harness-otel

OpenTelemetry observer bridge for [@noetaris/harness](../core).

> **Status:** not yet released. Implementation tracked in F23.

## Overview

`@noetaris/harness-otel` bridges the harness `Observer` telemetry API to OpenTelemetry. It translates harness lifecycle events into OTel spans and metrics, giving you distributed tracing and token usage metrics with zero changes to your agent code.

Takes `@opentelemetry/api` as a peer dependency — works with any OTel SDK implementation (Node SDK, collector exporters, etc.).

## Installation

```sh
pnpm add @noetaris/harness-otel
```

Peer dependencies:

```sh
pnpm add @noetaris/harness @opentelemetry/api
```

Requires Node.js ≥ 22.

## Usage

```ts
import { createOtelObserver } from '@noetaris/harness-otel'
import { trace, metrics } from '@opentelemetry/api'

const observer = createOtelObserver(
  trace.getTracer('my-agent'),
  { meterProvider: metrics.getMeterProvider() },
)

h.observe(observer)
```

## API

### `createOtelObserver(tracer, options?)`

Returns an `Observer` that maps harness events to OTel spans and metrics.

**Span hierarchy:**

| Harness event | OTel action |
|---------------|-------------|
| `onRunStart` | Creates root span `"agent.run"` with `agent.id` and `session.id` attributes |
| `onStepStart` | Creates child span `"agent.step"` with `step.name` attribute |
| `onStepEnd` | Closes the step span with `durationMs` |
| `onStepError` | Sets step span status to error |
| `onRunEnd` | Closes the root span |

**Metrics** (requires `options.meterProvider`):

| Harness event | OTel metric |
|---------------|-------------|
| `onEvent("llm.response", { tokens })` | Increments token counter (input and output) |
| `onStepEnd` | Records step duration to a histogram |

**Options:**

| Option | Type | Description |
|--------|------|-------------|
| `parentContext` | `Context` | OTel context for the root span. Defaults to `context.active()`. |
| `meterProvider` | `MeterProvider` | Enables metrics. Omit to skip metric recording. |

## Related Packages

- [`@noetaris/harness`](https://github.com/noetaris-lab/harness) — core execution engine
- [`@noetaris/harness-anthropic`](https://github.com/noetaris-lab/harness-anthropic) — Anthropic Claude adapter (emits `"llm.response"` events)
- [`@noetaris/harness-openai`](https://github.com/noetaris-lab/harness-openai) — OpenAI adapter (emits `"llm.response"` events)
- [`@noetaris/harness-google`](https://github.com/noetaris-lab/harness-google) — Google Gemini adapter (emits `"llm.response"` events)

## License

MIT
