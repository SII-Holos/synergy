# Decision Record: Narrow agent preamble messages to key moments

Status: implemented

## Problem

The shared preamble guidance injected into every agent prompt instructed: "Before using tools, send one brief sentence telling the user what you are about to do." On surfaces where tool calls are already visible (desktop and web), this produced constant narration of routine reads, searches, and edits. Routine operations were treated the same as moments that genuinely need the user's attention, making agents feel verbose and drowning out the messages that matter.

## Decision

Rework the injected `## Preamble Messages` section in `packages/synergy/src/agent/prompt/preamble.ts`:

- State that tool calls are already visible as they happen, so routine reads, searches, edits, and commands must not be narrated.
- List the moments worth a short message: starting a multi-step task (one sentence on the plan), key decisions (what is being chosen and why), unexpected findings or risks (what differs from expectations), and completion (outcome and anything still uncertain).
- Keep each message concise, concrete, and forward-looking — one sentence by default.

The section heading is unchanged, so the idempotent `withPreambleSection` injection — applied to native LLM turns in `session/llm.ts` and external-agent instructions in `session/invoke.ts` — needs no code changes.

## Alternatives considered

- **Differentiate UI vs non-UI (channel) surfaces** — rejected for now: channel sessions without a tool-call UI still receive start and completion messages from the key-moments list, and the preamble builder currently has no endpoint context; one consistent prompt keeps behavior uniform and the change minimal.
- **Remove the injected section entirely** — rejected: the section was centralized from scattered per-agent prompt text, and dropping it entirely would let per-agent prompts drift again and risk silent agents even in UI contexts.

## Consequences

Agents stop narrating routine tool calls; messages concentrate on plan starts, decisions, findings, and completion. Channel users see fewer mid-task pings but retain start/end coverage. Prompt text changed for both native and external-agent paths; no code paths or tests changed (no tests assert the literal prompt text).
