# Decision Record: Visible reasoning word progress

Status: implemented

## Problem

While an assistant message streams reasoning, the `Thinking` row can look unchanged for long stretches, so ongoing generation is not perceptible. No reliable live per-message token stream exists to drive such a signal: Part usage is terminal and provider-dependent, the throttled `usage.updated` event is accounting-oriented, and browser sync frames are convergent and coalesced while a page is hidden, so browser cadence cannot prove provider liveness.

## Decision

A shared pure helper counts generated words from reasoning text the browser already holds. `countReasoningWords(texts, locale)` in `packages/ui/src/components/reasoning-word-count.ts` segments each canonical reasoning Part independently with `new Intl.Segmenter(locale, { granularity: "word" })` and counts only segments whose `isWordLike` is true, summing in canonical Part order. Source text is never stripped, escaped or Markdown-parsed.

The count derives from the active Lingui locale (`i18n().locale`) in a memoized client computation, so it follows locale changes. It is a generated-word proxy and never a provider token count. The count is cumulative and remains visible after the run settles, beside the settled `Reasoning` label. No count renders until a positive word count exists, so empty, whitespace-only and punctuation-only reasoning are visually unchanged.

`AnimatedActivityCount` and its CSS moved out of `packages/ui/src/components/activity-trace.tsx` into `packages/ui/src/components/animated-activity-count.tsx` and `.css`. It keeps its `value`, `identity` and optional `animate` API, its 180 ms locale-formatted number transition, numeric stability, timer and width-motion cleanup, and its `prefers-reduced-motion` handling. `activity-trace.tsx` re-exports it, so no consumer broke.

The standard disclosure in `packages/ui/src/components/process-reasoning.tsx` (`ProcessReasoning`) renders the state label plus the animated count and an ICU-plural unit in its trigger, and its button-level `aria-label` carries the full localized status including the toggle action, the state and the current count. Compact mode in `packages/ui/src/components/compact-reasoning.tsx` (`CompactReasoningLine`) renders the same count between the running state label and the scrolling streamed text, and its settled visible label changed from `Thinking` to `Reasoning` to match the standard path. It receives a stable canonical `identity` derived from the timeline message/Part identity (`timelineItemStableKey`), never from text or count.

App-owned Lingui descriptors were added for the plural unit and both full status labels (`session.reasoning.words`, `session.process.viewReasoningStatus`, `session.process.hideReasoningStatus`) and extracted through the App catalog tooling. No server route, event, schema, OpenAPI or SDK regeneration, persisted state, migration or usage-accounting change is involved. Canonical Part IDs, message IDs, text, order, reasoning anchors, disclosure identity and expansion, keyboard behavior, focus-visible rings, scroll behavior and continuous grouping are unchanged. The visible count shares the presentation-local boundary of [message arrival motion](2026-10-04-message-arrival-motion.md): it is derived from text the browser already has and adds no protocol, persisted state or transport behavior.

## Alternatives considered

**Adding live token/usage fields or a new server event.** Usage is terminal and provider-dependent; it would expand the wire contract, persistence and replay, OpenAPI and the generated SDK surface for a visual signal.

**Inferring progress or stalls from event timing.** Streaming frames are unsequenced and coalesced in hidden pages, so a slow browser queue would be misreported as a provider stall.

**Displaying characters, deltas or chunks.** These are visually unstable transport units that do not communicate human-readable wording progress.

**Grapheme-granularity segmentation or hand-rolled whitespace counting.** Grapheme units measure script glyphs, and whitespace counting fails Unicode languages, punctuation, Markdown and mixed text.

**Showing a zero count for empty or punctuation-only text.** It adds noise before meaningful wording exists.

**Animating the complete status sentence or rebuilding it from translated fragments.** This conflicts with the number-only motion convention and could break locale word order.

**Leaving the settled compact row labeled `Thinking`.** The standard path already switches to `Reasoning`, and two settled labels for one semantic state is inconsistent.

## Consequences

It bought a cheap, immediately understandable, locale-aware progress signal derived only from text the browser already has, with no API or persistence growth. It knowingly gives up exactness: `Intl.Segmenter` word units are browser- and ICU-dependent rather than a provider tokenizer, and a streaming partial suffix may lag until a delimiter arrives.

The count is a cumulative rendering measure, not a heartbeat, and must never be presented as proof that the provider is alive; no timeout, stall, retry or telemetry behavior follows from it. The shared UI package stays product-agnostic and consumes the App-owned Lingui provider. Tests exercise the visible behavior: a user sees the count increase as reasoning streams, retains the final cumulative value after settlement, loses no count for punctuation-only or empty reasoning, and keeps the existing reasoning controls with equivalent accessibility — the button accessible name includes the action, the state and the count — and unchanged narrow-layout behavior. The reasoning disclosure and its accessible-name contract remain owned by the [semantic process disclosure decision](../feature/2026-10-04-semantic-process-disclosure.md); settled-row continuity and reading behavior remain owned by the [conversation process stability decision](../bug-fix/2026-10-05-conversation-process-stability.md).
