# Decision Record: sanitize non-JSON-safe provider metadata in model prompt projection

Status: implemented

## Problem

A turn's second LLM step failed with `AI_InvalidPromptError: The messages must be a ModelMessage[]` whenever the active model was `openrouter/z-ai/glm-5.3-flash`, while every other provider worked. The failure was invisible to disk forensics: replaying the session's persisted messages through the same projection and AI SDK 5.0.212 validation always passed, and restarting the runtime healed the session.

Root cause chain, reproduced end-to-end against the real provider package:

1. `@openrouter/ai-sdk-provider` 1.5.2's streaming path accumulates reasoning details with `lastDetail.signature = lastDetail.signature || detail.signature`. When the upstream model omits `signature` (glm does), this assignment creates an own key `signature: undefined` on the accumulated object, and the polluted array is attached by reference to every `tool-call` event's `providerMetadata.openrouter.reasoning_details`.
2. Synergy stored that stream-event metadata into in-memory `part.metadata` unchanged, and the next step's prompt projection passed it through as `providerOptions` / `callProviderMetadata`.
3. AI SDK 5.0.212 validates prompts with a zod schema whose `providerOptions` values must be JSON values; `undefined` fails validation and rejects the whole prompt. Bun IPC "advanced" (v8) serialization preserves undefined-valued keys, so the pollution survived host→worker transfer.

The transport asymmetry explains every symptom: disk persistence and HTTP/SSE use JSON serialization, which drops undefined keys and coerces `NaN`/`Infinity` to `null` — so only the in-memory prompt path ever saw the invalid values, only providers whose metadata carried them failed, and only from the second step onward (the first step has no assistant history with metadata yet).

The violated invariant belongs to the prompt boundary: every `ModelMessage[]` handed to the AI SDK must be JSON-safe, regardless of what any provider attaches to metadata in memory.

## Decision

Prompt projection now sanitizes the payload fields it derives from untrusted in-memory state in `packages/synergy/src/session/message-v2.ts`. A `sanitizePromptPayload` helper performs a JSON round-trip with a `BigInt` → string replacer (undefined-valued keys are dropped; `NaN`/`Infinity` become `null`; arrays lose undefined entries to `null`), and returns `undefined` if serialization throws (e.g. circular references). It is applied at the exits where projection copies provider-controlled values into the prompt: `modelProviderMetadata()` (feeding text/reasoning `providerMetadata` and tool-call/tool-result `providerOptions`) and tool `state.input` / `state.output` projection. The helper is pure and silent — `projectModelMessages` stays a pure function.

The sanitization deliberately targets the payload fields before `convertToModelMessages` rather than the returned message graph: the AI SDK converter itself adds schema-legal structural keys with undefined values (e.g. `providerExecuted`), which existing tests pin and downstream code may rely on; only projection-owned payloads need the JSON-safety guarantee. Clean metadata round-trips idempotently, so well-behaved providers are unaffected beyond the conversion cost.

## Alternatives considered

**Fix only upstream (`@openrouter/ai-sdk-provider`)** — a one-line `??` fix removes this instance at the source. Rejected as the sole measure: protection would not exist in this repository until a provider release ships and is upgraded, and the same failure class can arrive from any provider attaching non-JSON-safe metadata. The upstream issue tracks the source fix; this boundary guards the invariant independently.

**Sanitize at processor ingest** (when stream events write `part.metadata`) — rejected: the invariant owner is the prompt projection boundary. Disk, frontend, and exports are already JSON-transport-clean, so ingest-time cleaning would add a conversion to every part write while still leaving `projectModelMessages` able to emit invalid prompts from any other source.

**Upgrade or pin the provider package** — rejected: 1.5.2 is the current published version and contains the bug; no fixed release is known. Dependency changes stay out of this fix's scope.

**Sanitize the entire returned `ModelMessage[]` after conversion** — rejected: it would also strip schema-legal undefined-valued structural keys the AI SDK converter itself adds (`providerExecuted`, absent `providerOptions`), changing behavior pinned by existing tests without adding protection where the risk actually lives (provider-controlled payloads).

## Consequences

Model prompts are now JSON-safe by construction at the projection boundary, closing the whole failure class for every current and future provider rather than only the openrouter instance. The trade-off is that malformed metadata is silently cleaned instead of crashing the turn — an accepted exchange of an opaque hard failure for a degradable one, with the root cause documented here and reported upstream so the provider-level fix can land. `NaN`/`Infinity` now reach the model as `null`, matching what disk persistence already produces, so in-memory and post-restart prompts converge instead of diverging. Each projection performs one additional JSON round-trip per provider-metadata/payload field, the same cost class as the provenance stringification already done in this function.

## Review follow-ups (2026-08-29)

An in-depth review of the first fix found the projection could still throw on the pollution class it claimed to neutralize, and refined three secondary aspects:

**Shared sanitized values for prompt fields and provenance.** The provenance contributions stringified the raw `part.state.input` (`JSON.stringify` without the replacer), so a BigInt or circular tool input threw from inside `projectModelMessages` itself — the sanitize helper's try/catch never saw it. Both terminal tool branches now sanitize once into a local `input` and feed the same product to the prompt part and the provenance contribution, which also removes the double serialization of every tool input.

**String fast-path.** `state.output` is schema-pinned to `z.string()` and strings are already JSON-safe; the helper returns them unchanged instead of paying a full stringify+parse round-trip on the largest field of every historical tool result.

**Observability instead of silence.** The replacer now counts what it does — `converted` (BigInt → string, Date → ISO string, NaN/Infinity → null), `dropped` (undefined values), `failed` (payloads removed whole, e.g. circular) — surfaced as `sanitization` on the projection result. The invoke loop logs one line whenever any counter is non-zero, so a provider regressing into this failure class is visible in logs instead of surfacing only as silently altered prompts.

**Value-mapping asymmetry, accepted.** BigInt is preserved as a string while NaN/Infinity degrade to `null`. This follows `JSON.stringify` semantics — which disk persistence already applies — so in-memory and post-restart prompts converge; keeping the number-ish values as strings mirrors what a restart would have produced for them too.

The JSON round-trip also covers Date values (→ ISO string) and exotic objects like Uint8Array/Map (→ their JSON-serializable shape), matching what the disk path has always produced for them.
