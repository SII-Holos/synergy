# Decision Record: Provider stream watchdogs cover the header-to-first-byte window

Status: implemented

## Problem

A model request could be accepted by an upstream gateway and then held open for minutes with no action taken by Synergy. The user-visible symptom was a turn that appeared frozen and eventually completed after an unexplained delay; the observability data showed the same code path producing wildly different latency depending on the provider:

| model                         | n   | p50     | p90      | p99      | max           |
| ----------------------------- | --- | ------- | -------- | -------- | ------------- |
| `bailian/deepseek-v4.1-flash` | 64  | 4,214ms | 10,526ms | 29,499ms | **179,849ms** |
| `deepseek-flash`              | 60  | 2,441ms | 2,916ms  | 3,411ms  | 4,119ms       |

`session.turn.retry` and `session.turn.error` were both zero across the whole window: nothing was ever retried, because nothing ever timed out. Two independent defects made the request path unguarded in its most exposed window:

1. **The TTFB watchdog was cleared by response headers, not by the first byte.** `Provider.getSDK` installed a timer documented as covering "time from fetch start to first byte", but cleared it as soon as `await fetch(...)` returned. Bun resolves `fetch()` on response headers (measured at 202 ms against a raw socket that withheld the body for 3 s), so a gateway that answered with headers and then withheld the body left the request with no timer at all.
2. **The idle watchdog was only armed after the first chunk**, so the entire period between "headers received" and "first body byte" was covered by neither watchdog.

A controlled experiment against a local mock proved the gap: with an immediate header flush and a 25 s body hold, and `ttfb_sec=3600 / idle_sec=10` configured, the client waited the full 25 s and never abandoned the request.

The configured defaults were also not protective, but the reason is narrower than the numbers alone suggest. `providerWallMs` defaulted to 0, so a stream that kept emitting keep-alive traffic without ever producing content was unbounded. `providerTtfbMs` defaulted to 3,600,000 and `providerIdleMs` to 900,000. Critically, **the TTFB window is not the network round trip for a gateway that withholds headers until generation starts**: measurement against the gateway in use showed headers and the first body byte arriving together (Δ=0 ms across 0.3 MB to 4 MB requests), which means that window covers connect, upload, and prompt prefill, and it grows with context size (measured 0.7 s at 8 tokens, 3.1 s at 65k, 11.6 s at 260k, 28.1 s at 523k). During prefill only the TTFB timer is armed, because the idle timer arms on the first byte, so a TTFB budget that is too small aborts legitimate prefill and every retry restarts that prefill from scratch.

Finally there was no empty-response guard: a provider returning a completed response (`finishReason === "stop"`) with no text and no tool calls produced a silently empty turn rather than a retryable error.

## Decision

Sync is unchanged in structure and the guard is repaired at the seam that was missing:

- **The TTFB watchdog now ends at the first body byte.** `ProviderStream.withIdleTimeout` gained an `observer` hook that fires once when the first body chunk is observed. The TTFB timer is cleared from that callback instead of from the `fetch()` return, which is what the timer's own documentation claimed. All response bodies are wrapped, not only SSE ones, so a non-SSE body also clears the watchdog it started.
- **Defaults are set to values that bound a stall without cutting into prefill or thinking**: `providerTtfbMs` 3,600,000 → 300,000, `providerIdleMs` 900,000 → 120,000, `providerWallMs` 0 → 1,800,000 (now enabled). The TTFB value matches the reference harness, which has exactly one stream watchdog at 300 s and no separate TTFB timer, and it keeps roughly 10x headroom over the largest prefill measured on this path (28.1 s). `invokeMs` (6 h), `toolDefaultMs` (2 h), and `permissionAskMs` (1 h) are deliberately unchanged: they govern step and tool lifetime, not a single HTTP request, and they are what lets long-running sessions continue. Each watchdog is created inside one request's closure, so changing them cannot shorten a long task; it only bounds any single request.
- **A per-provider override exists for legitimately slow models.** `provider.<id>.timeout` accepts `{ ttfb_sec, idle_sec, wall_sec }` in the same shape and unit as the global block. `TimeoutConfig.forProvider()` is the single resolution path, layering `provider.<id>.timeout` over the legacy `provider.<id>.options.timeout` (milliseconds, idle only) over the global block over the defaults. Both the control plane (`LLM.prepare`) and the agent worker (`Provider.getSDK`) call it, so the two sides cannot disagree.
- **The legacy `options.timeout` shorthand is captured and then removed before the SDK factory call.** It was previously passed through to `@ai-sdk/openai-compatible` as an unknown option. The removal point is order-sensitive: the value must be read for `forProvider()` before it is deleted.
- **An empty completed response is a retryable error.** The terminal `finish` stream event treats a completed `stop` response with zero turn-cumulative text output and no deferred tool calls as `MessageV2.EmptyResponseError`, mapped in `fromError` to `APIError { isRetryable: true, metadata: { code: "empty_response" } }` so the existing turn-level retry chain owns the retry. The throw happens before `retryEligible` is cleared. A turn that produced only reasoning is treated as empty on purpose: the user sees no output, which is the symptom being caught.
- **Watchdog aborts are recorded with their kind.** `llm.watchdog.fired` carries `kind: "ttfb" | "idle" | "wall"`, and the default measurement is scoped so a fire cannot be recorded for a response that already settled.

## Alternatives considered

- **Only add the per-provider override and leave the defaults alone** — rejected: an unbounded `wall_sec` and a 15-minute idle budget leave a held-open or keep-alive-fed request waiting far longer than any prefill needs, and only providers someone remembered to configure would benefit.
- **Only tighten the defaults and leave the TTFB clear point where it was** — rejected: the controlled experiment showed the header-to-body window has no timer at all, so raising or lowering the thresholds changes nothing in exactly the case that stalled. The clear point is the root cause.
- **Arm the idle watchdog from `fetch()` start and drop TTFB** — rejected: it would judge a slow reasoning prefill with the same threshold as a dead connection, make "slow" and "stuck" indistinguishable, and leave the existing `ttfb_sec` configuration meaningless.
- **Adopt SSE comment-frame heartbeats as a liveness pulse** — rejected: a gateway that emits keep-alive frames forever would never time out, converting a bounded stall into an unbounded one. `wall_sec` bounds that stream instead, without changing the SSE parser.
- **Model the empty-response case as a new `providerRetryable` code branch** — rejected: that function classifies provider and transport failures; an empty completed response is a semantic verdict about the turn, and mapping it to a retryable `APIError` reuses the existing retry chain with a smaller blast radius.
- **Raise `maxRetries` on the main turn to get in-stream retries** — rejected: it would stack an SDK-level retry layer on the turn-level `SessionRetry`, and the AI SDK's own retry can replay a stream, which `LLM.stream` explicitly guards against.

## Consequences

A request that is accepted and then held open is abandoned and retried when its configured watchdog budget expires, and the same path covers a stream that goes quiet mid-response and a stream that emits only keep-alive traffic. Legitimate slow models keep an escape hatch, but the escape hatch is now opt-in per provider rather than the global default, so a provider that has not been configured to be slow no longer gets hour-scale silence.

The trade-off is that a provider whose prefill genuinely exceeds 300 s, or that goes quiet for more than 120 s mid-stream, will be interrupted and retried, and a retry restarts that prefill. The 300 s budget is the same span the reference harness allows for the whole window, the largest prefill measured here was 28.1 s, and the largest inter-chunk gap measured during an 83 s thinking phase was 2.9 s, so `idle_sec=120` retains roughly 40x headroom. `llm.watchdog.fired{kind="ttfb"}` surfaces a misclassification immediately instead of hiding it.

The worker-side metrics these watchdogs record now reach storage through [Forward Agent worker metrics to the host over the Agent turn IPC channel](2026-09-21-worker-to-host-metric-forwarding.md).

Final request policy is resolved after model options are merged: provider `timeout` fields override the legacy model `options.timeout`, then provider `options.timeout`, then global timeout fields and defaults. Legacy values are milliseconds and affect idle only. Both SDK and language-model cache identities include the effective policy and requested model; credential fingerprints retain their existing role. This costs an SDK entry per distinct model/policy but avoids stale timers and model labels when a worker is reused. `wall_sec: 0` remains an explicit disable value at global and provider levels.

Preparation accepts a supplied model specification even when its provider is not registered. In that case, option resolution uses the model's options and global policy, preserving variant validation and sessionless preparation without requiring SDK initialization.

Every request owns and clears its watchdog timers on completion, failure and cancellation. The wall watchdog uses a JavaScript timer in the request context: a native timeout-signal callback can lose Runtime asynchronous context and therefore drop its metric. Real worker tests cover all three watchdog kinds through host database insertion, and full-server tests verify the resulting retries and recovery.
