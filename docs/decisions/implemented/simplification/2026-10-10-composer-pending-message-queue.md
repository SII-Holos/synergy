# Decision Record: Attach pending user messages to the Composer

Status: implemented

## Problem

A task or guide message awaiting delivery is still editable execution input, not an accepted transcript turn. Placing its controls at the conversation tail makes it look like conversation history and puts it out of reach while the user reads earlier output.

## Decision

The built-in Session page renders its existing pending Inbox projection in a compact queue directly above the Composer. The queue shares the input column, has an inset rounded top edge connected to the input shell, and scrolls internally at a bounded height. The Dock observer includes its height in conversation clearance, and the Composer deducts that height from available editing space. Expanded editing hides the queue without cancelling its messages.

Composer motion remeasures the expanded or collapsed target without cancelling its captured transition for the expected pending-height reservation change. External viewport or pane changes still invalidate stale geometry.

The page keeps the existing user-origin, task/steer, visibility and materialized-message filters. Rows retain stable Inbox IDs, and the queue owner is isolated by connection, Scope and Session identity. Guide/Queue, withdrawal, action errors, first-task locks and rollback freezing keep their existing semantics. First-send optimistic messages and their process status remain in the conversation. Task details retains the complete Inbox with context, retry and removed history. Public plugin conversation and Composer layout services remain unchanged.

Provenance: The user's Codex queue screenshots supplied for this task show pending input attached immediately above the Composer. The public [Codex application features](https://developers.openai.com/codex/app/features/) page provides workflow context, not verification of that queue layout.

Local adaptation: Adopt the attached pending-input placement and quiet row hierarchy, while preserving Synergy's server-owned Inbox modes, controls, delivery deduplication and measured Dock. No upstream code or visual assets are copied, and no new pause/resume state is inferred from the screenshots.

## Alternatives considered

**Keep pending cards in the transcript.** Preserves their existing placement but misrepresents undelivered input and requires scrolling to reach its controls.

**Mount the complete Inbox through the public Composer layout slot.** Includes context and history that belong in Task details, changes replacement-layout behavior, and duplicates the full management surface. An internal Dock prop preserves the public service while rendering only the existing pending-user projection.

**Create a separate client-side queue.** Adds competing state and delivery races. The durable Inbox already supplies the required identities and lifecycle.

## Consequences

Pending input stays beside the draft and its controls remain reachable independently of conversation reading. Delivery removes the queue row by canonical message identity without an extra transcript bubble or empty spacer. A bounded queue can require internal scrolling, and expanded editing temporarily defers access to pending controls until collapse. The change adds no API, persistence migration or scheduling behavior.

Existing selector and recovery tests retain their lifecycle coverage. The real Dock/Composer browser regression adds placement, empty-state height, editing-space reservation, stable mode updates, async session isolation, first-task/rollback restrictions, narrow geometry and expanded-editor motion coverage. Whole-page acceptance uses an isolated production Web origin and synthetic inference with the real backend and SDK; it does not establish native IME behavior or model quality.
