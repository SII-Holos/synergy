# Decision Record: Durable live model and thinking selection

Status: implemented

## Problem

The model selector saved a session override while thinking choices lived in browser storage and the running loop continued reading its root message. The toolbar, Settings and actual request could therefore describe different choices. An empty variant also conflated inherited defaults with an explicit request to use provider defaults, and thinking could not be disabled consistently across transports.

## Decision

The session owns one revisioned model/thinking selection, per-model preferences and the last request selection. A dedicated API validates against the owning Scope and rejects stale revisions. The client serializes writes, uses accepted responses as its next baseline and surfaces pending or failed saves. Settings and the desktop/mobile toolbars share a directly selectable thinking menu. Legacy override resets also advance the revision, preventing stale writes from becoming valid again.

The loop captures the selection before prompt and tool preparation. That request uses the same model for context limits, tools, provider options and accounting. Historical roots remain unchanged; assistant metadata and rollout requests preserve actual request choices. Ongoing streams and completed tools are retained. Anthropic model or thinking-mode transitions inside tool-use turns wait for a new root; same-mode effort changes can apply to the next request.

Thinking has three explicit meanings: provider-default, Off and a concrete variant. Provider-default removes reasoning overrides after ordinary parameter hooks. Off requires a known disable mapping for that model and transport or explicit model configuration. Catalog toggle, null effort and budget bounds survive parsing. Custom variants remain supported. Small calls and compaction keep their independent settings.

The request-snapshot design is informed by [DeepSeek Harness model selection](https://github.com/deepseek-ai/deepseek-harness/blob/46a7f68b0922371ce7144b668b90e377d8e799f4/packages/core/agent/src/model-selection.ts); Synergy adds SQL persistence, revisions and its existing session event projection. The Anthropic restriction follows [thinking with tool use](https://platform.claude.com/docs/en/build-with-claude/thinking#thinking-with-tool-use). DeepSeek mappings follow its [thinking-mode API](https://api-docs.deepseek.com/guides/thinking_mode/). These inform the behavior; no upstream implementation is copied.

## Alternatives considered

**Keep browser choices and rewrite the root.** This leaves multiple clients without one authority and changes historical task facts.

**Change only the final provider hook.** The provider would receive a new model after context limits, prompt projection and tool schemas had already been prepared for another model.

**Interrupt and restart on each change.** This discards an in-flight response and risks replaying side effects. Request-boundary application preserves work.

**Train an automatic effort controller first.** Automatic routing needs a reliable control and measurement surface. This change establishes that surface; adaptive routing remains separate work.

## Consequences

Manual controls converge across reloads and clients, and a future controller can use the same revisioned API. Old durable roots seed per-model preferences through a versioned migration; browser-only null sentinels do not acquire a new meaning. Explicit unsupported choices fail rather than silently changing level.

Provider defaults remain provider-owned and may change without a Synergy release. Some model transitions wait for a protocol-safe turn boundary. Global Settings and project sessions can legitimately have different catalogs; the UI explains that scope difference. External-agent thinking controls remain unavailable until their adapters declare support.

Verification covers real delayed compatible-provider requests across A/high → B/low → A/high, unchanged tool execution counts, Default/hook normalization, disable mappings through the locked SDK, revision conflicts, per-model restoration, migrations and Anthropic tool-turn deferral.
