# Decision Record: Novel progress guidance

Status: implemented

## Problem

An Agent can repeatedly describe the same unresolved issue as an important finding during a tool sequence. A trigger based on importance alone does not distinguish a discovery from a restatement. Adding more prohibitions increases prompt length without making that distinction clearer.

## Decision

The shared guidance in `packages/harness/src/agent/prompt/progress.ts` asks the Agent to briefly state its initial direction for substantial work and share meaningful progress. Later updates qualify only when information is new relative to what the Agent already told the user and changes expectations or requires attention. Rewording the same issue does not qualify. Between updates, the Agent continues with tools; conclusions follow results in the user's language with relevant verification.

The replacement reduces the section from 130 to 89 whitespace-delimited words, including its heading. Primary prompt builders and runtime injection keep the same shared owner and single-injection behavior. This refines the progress trigger and initial explanation in [chronological reasoning and stable conversation motion](2026-10-02-chronological-reasoning-and-stable-conversation-motion.md) without changing message storage, tool execution or frontend presentation.

## Alternatives considered

**Append a longer list of prohibitions and examples.** Duplicates existing guidance and increases instruction cost; replacing the trigger states the missing distinction directly.

**Default to silent execution.** Removes useful orientation and progress visibility along with the repetitive narration. Substantial work needs concise communication, not a zero-update target.

**Use fixed update counts or time thresholds.** Counts and elapsed time do not establish new information or a need for user attention.

**Filter repeated assistant text at runtime.** Adds a separate enforcement mechanism that could suppress a useful correction or blocker; this change remains scoped to the prompt's decision criterion.

## Consequences

The instruction is shorter and gives the Agent an explicit comparison against its prior communication. Important findings, changed approaches, blockers and decisions still warrant updates when they satisfy that criterion. The assembled-prompt tests verify distribution and idempotent injection, not model compliance. Reduced repetition remains a model-behavior claim requiring observed multi-step tasks; no cross-model or before-and-after improvement is established by these tests.
