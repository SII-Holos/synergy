# Decision Record: Animate newly arriving conversation content

Status: implemented

## Problem

Submitted user bubbles, streamed text suffixes and tool calls first observed after completion appear abruptly. Animating an entire message on each update would repeatedly fade readable text and replay motion when a virtual row remounts.

## Decision

The App records a short-lived, consumable arrival for an actual optimistic submission, scoped to its server, Scope, Session and message identity. The transition provider owns this presentation state separately from persisted messages. An unconsumed arrival follows canonical identity handoff; a consumed arrival cannot replay. A following conversation consumes it when mounting the user bubble and uses the existing base duration with a six-pixel entrance. Removed submissions and expired arrivals cannot animate historical rows.

The streaming Markdown renderer treats its first snapshot and replacement snapshots as settled content. Subsequent appended text receives an opacity-only transition using the slow motion duration. Characters that complete an existing grapheme join its original text node before a new fade starts. At most 32 transient spans coexist per renderer; excess text remains immediately readable. Animation settlement unwraps spans without rebuilding paragraphs. Selection suspends unwrapping until released; terminal rendering and disposal release all transient work. Reduced motion and hidden documents settle active fades. The parser, source text, URL filtering and authoritative snapshots remain unchanged.

Current tool steps use the existing disclosure motion even when their first observed receipt is already completed. Existing activity disclosure, following gates, focus retention and reading anchors continue to own layout movement. The change adds no typewriter delay or smooth-scroll queue.

The public Codex [streaming controller](https://github.com/openai/codex/blob/afb436df8b70bb5bc57b86d9a3e829968988cd21/codex-rs/tui/src/streaming/controller.rs) informed the separation between settled content and incoming content. Synergy retains its DOM parser and applies bounded, temporary suffix fades; it does not copy the terminal controller or its pacing algorithm. This extends the [stable conversation motion decision](../bug-fix/2026-10-02-chronological-reasoning-and-stable-conversation-motion.md), whose chronology and terminal paragraph identity requirements remain applicable.

## Alternatives considered

**Animate every mounted message.** Virtualization, history loading and navigation mount existing messages, so mount alone cannot establish a fresh user submission.

**Fade the entire Markdown block on each update.** This repeatedly dims text the user is already reading and combines poorly with terminal rendering.

**Queue characters and smooth-scroll every update.** This adds visible latency and competing scroll requests. Existing frame batching and reading-anchor ownership are retained.

## Consequences

Motion remains local to presentation and introduces no persisted flags or protocol changes. Actual text and tool state stay available immediately. Very large bursts can exceed the transient-node budget and display their remaining suffix without a fade; correctness and bounded work take priority over animating every byte. The two-second submission lease deliberately expires if navigation or rendering is delayed.
