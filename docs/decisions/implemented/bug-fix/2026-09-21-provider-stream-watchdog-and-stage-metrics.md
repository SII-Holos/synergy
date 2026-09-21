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

The configured defaults were also not protective. `providerTtfbMs` defaulted to 3,600,000 (one hour) and `providerWallMs` to 0 (disabled), so even a correct watchdog would not have fired within any plausible user patience; production data recorded zero first-token events above 300 s while 9 of 121 events (7.4%) exceeded 10 s and accounted for 42% of all first-token time.

Finally there was no empty-response guard: a provider returning a completed response (`finishReason === "stop"`) with no text and no tool calls produced a silently empty turn rather than a retryable error.

## Decision

Sync is unchanged in structure and the guard is repaired at the seam that was missing:

- **The TTFB watchdog now ends at the first body byte.** `ProviderStream.withIdleTimeout` gained an `observer` hook that fires once when the first body chunk is observed. The TTFB timer is cleared from that callback instead of from the `fetch()` return, which is what the timer's own documentation claimed. All response bodies are wrapped, not only SSE ones, so a non-SSE body also clears the watchdog it started.
- **Defaults are tightened to protective values**: `providerTtfbMs` 3,600,000 → 15,000, `providerIdleMs` 900,000 → 120,000, `providerWallMs` 0 → 1,800,000 (now enabled). `invokeMs` (6 h), `toolDefaultMs` (2 h), and `permissionAskMs` (1 h) are deliberately unchanged: they govern step and tool lifetime, not a single HTTP request, and they are what lets long-running sessions continue. Each watchdog is created inside one request's closure, so tightening them cannot shorten a long task; it only bounds any single request.
- **A per-provider override exists for legitimately slow models.** `provider.<id>.timeout` accepts `{ ttfb_sec, idle_sec, wall_sec }` in the same shape and unit as the global block. `TimeoutConfig.forProvider()` is the single resolution path, layering `provider.<id>.timeout` over the legacy `provider.<id>.options.timeout` (milliseconds, idle only) over the global block over the defaults. Both the control plane (`LLM.prepare`) and the agent worker (`Provider.getSDK`) call it, so the two sides cannot disagree.
- **The legacy `options.timeout` shorthand is captured and then removed before the SDK factory call.** It was previously passed through to `@ai-sdk/openai-compatible` as an unknown option. The removal point is order-sensitive: the value must be read for `forProvider()` before it is deleted.
- **An empty completed response is a retryable error.** `step-finish` treats `finishReason === "stop"` with zero text output and no tool calls as `MessageV2.EmptyResponseError`, mapped in `fromError` to `APIError { isRetryable: true, metadata: { code: "empty_response" } }` so the existing turn-level retry chain owns the retry. The throw happens before `retryEligible` is cleared. A step that produced only reasoning is treated as empty on purpose: the user sees no output, which is the symptom being caught.
- **Watchdog aborts are recorded with their kind.** `llm.watchdog.fired` carries `kind: "ttfb" | "idle" | "wall"`, and the default measurement is scoped so a fire cannot be recorded for a response that already settled.

## Alternatives considered

- **Only add the per-provider override and leave the defaults alone** — rejected: production recorded zero first-token events above 300 s, so a one-hour default is indistinguishable from no guard; only providers someone remembered to configure would benefit.
- **Only tighten the defaults and leave the TTFB clear point where it was** — rejected: the controlled experiment showed the header-to-body window has no timer at all, so raising or lowering the thresholds changes nothing in exactly the case that stalled. The clear point is the root cause.
- **Arm the idle watchdog from `fetch()` start and drop TTFB** — rejected: it would judge a slow reasoning prefill with the same threshold as a dead connection, make "slow" and "stuck" indistinguishable, and leave the existing `ttfb_sec` configuration meaningless.
- **Adopt SSE comment-frame heartbeats as a liveness pulse** — rejected: a gateway that emits keep-alive frames forever would never time out, converting a bounded stall into an unbounded one. `wall_sec` bounds that stream instead, without changing the SSE parser.
- **Model the empty-response case as a new `providerRetryable` code branch** — rejected: that function classifies provider and transport failures; an empty completed response is a semantic verdict about the turn, and mapping it to a retryable `APIError` reuses the existing retry chain with a smaller blast radius.
- **Raise `maxRetries` on the main turn to get in-stream retries** — rejected: it would stack an SDK-level retry layer on the turn-level `SessionRetry`, and the AI SDK's own retry can replay a stream, which `LLM.stream` explicitly guards against.

## Consequences

A request that is accepted and then held open is now abandoned and retried on the order of seconds rather than being waited out, and the same path covers a stream that goes quiet mid-response and a stream that emits only keep-alive traffic. Legitimate slow models keep an escape hatch, but the escape hatch is now opt-in per provider rather than the global default, so a provider that has not been configured to be slow no longer gets hour-scale silence.

The trade-off is that a provider whose genuine time-to-first-token exceeds 15 s and whose provider was not configured will now be interrupted and retried. Production evidence puts that window in a natural gap between 13.7 s and 29.5 s, and `llm.watchdog.fired{kind="ttfb"}` surfaces the misclassification immediately instead of hiding it. `idle_sec=120s` retains roughly three orders of magnitude of headroom over the measured average chunk gap.

The worker-side metrics these watchdogs record now reach storage through [Forward Agent worker metrics to the host over the Agent turn IPC channel](2026-09-21-worker-to-host-metric-forwarding.md).

Two caveats are recorded rather than fixed here:

- **Per-provider front matter note.** `provider.<id>.options.timeout` is read for the legacy idle override at two call sites that see different option sets: `Provider.getSDK` reads the provider-level `options` it resolves itself, and `LLM.prepare` reads `provider.options` from the settled provider state, which does not include a per-model `options` block. A `timeout` declared under a _model_ entry therefore narrows the worker-side idle timeout without affecting the control-plane value shipped to the worker. Provider-level declarations, which is what the schema and documentation describe, agree on both sides.
- **A pre-existing generator defect keeps the regenerated configuration reference from reflecting the new defaults.** `gen-config-reference.ts` indexes flattened fields by name with a `Map`, so the last duplicate wins; the top-level `timeout` block is shadowed by the unrelated `question.timeout` number, and `provider`, `permission`, and `compaction` collide the same way. The generated page therefore still describes the timeout row with the question-timeout text. `schema.ts` and `TimeoutConfig` are authoritative for the new values. `parseObjectFields` is shared with `gen-tool-catalog.ts`, so fixing the shadowing changes the tool catalog output too and belongs in its own change.
