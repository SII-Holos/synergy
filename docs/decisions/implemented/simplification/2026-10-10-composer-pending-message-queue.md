# Decision Record: Attach pending user messages to the Composer

Status: implemented

## Problem

A task or guide message awaiting delivery is still editable execution input, not an accepted transcript turn. Placing its controls at the conversation tail makes it look like conversation history and puts it out of reach while the user reads earlier output.

## Decision

The built-in Session page renders its existing pending Inbox projection in a compact queue directly above the Composer. The queue shares the input column, has an inset rounded top edge connected to the input shell, and scrolls internally at a bounded height. The Dock observer includes its height in conversation clearance, and the Composer deducts that height from available editing space. Expanded editing hides the queue without cancelling its messages.

Composer motion remeasures the expanded or collapsed target without cancelling its captured transition for the expected pending-height reservation change. It tracks pane space independently of that reservation, so simultaneous external viewport, pane-height or header changes still invalidate stale geometry.

The page keeps the existing user-origin, task/steer, visibility and materialized-message filters. Rows retain stable Inbox IDs, and the queue owner is isolated by connection, Scope and Session identity. Rows use the raised content surface rather than navigation chrome, combine authored text Parts and show the shared compact attachment gallery plus saved note, Session and file-context references. Guide/Queue, deletion, action errors, first-task locks and rollback freezing keep their existing semantics. Delete names queue removal explicitly rather than suggesting that the content returns to the draft. First-send optimistic messages and their process status remain in the conversation. Task details retains the complete Inbox with context, retry and removed history. Public plugin conversation and Composer layout services remain unchanged.

Edit message moves a confirmed removed item into the existing empty Prompt draft using its saved promptDraft metadata, with authored Parts as the legacy fallback. It neither sends nor edits a transcript message. Existing drafts block the operation; revision, generation and owner checks retain new typing and requeue original input after a concurrent draft or Session change. The removed-item read verifies uncertain removal replies before the client repeats a write. Edited input uses ordinary explicit submission and current Composer execution choices rather than silently changing Agent or model selectors.

Recovery controls obey the same current first-task and rollback restrictions as ordinary queue actions. Withdrawal retry is hidden while frozen, and every activation rechecks eligibility as well as the in-flight operation lock so a retained control cannot bypass a later state change.

Latest following stays owned by the conversation scroll controller. It observes both content and viewport border boxes: on narrow screens, the relative Dock shrinks the viewport before Dock height delivery; on desktop, the absolute Dock changes content bottom padding without changing the content box or viewport. The observer consumes native border-box delivery rather than a helper that deduplicates by content-box dimensions. The page must not infer follow intent from the resulting bottom gap. Native reading input retains its existing cancellation and anchor protection. The bounded queue has an explicitly named keyboard scroll target and the shared visible focus treatment even when rollback or the first-task lock removes every action.

Provenance: The user's Codex queue screenshots supplied for this task show pending input attached immediately above the Composer. The public [Codex application features](https://developers.openai.com/codex/app/features/) page provides workflow context, not verification of that queue layout.

Local adaptation: Adopt the attached pending-input placement and quiet row hierarchy, while preserving Synergy's server-owned Inbox modes, controls, delivery deduplication and measured Dock. No upstream code or visual assets are copied, and no new pause/resume state is inferred from the screenshots.

## Alternatives considered

**Keep pending cards in the transcript.** Preserves their existing placement but misrepresents undelivered input and requires scrolling to reach its controls.

**Mount the complete Inbox through the public Composer layout slot.** Includes context and history that belong in Task details, changes replacement-layout behavior, and duplicates the full management surface. An internal Dock prop preserves the public service while rendering only the existing pending-user projection.

**Create a separate client-side queue.** Adds competing state and delivery races. The durable Inbox already supplies the required identities and lifecycle.

**Edit a copy while the original remains queued.** Allows the runtime to consume the original while the user edits. Confirmed removal plus the existing recovery record preserves one runnable input without adding another editor or scheduling state.

**Replace a nonempty draft or merge it silently.** Destroys or mixes unrelated intent. The editor requires an empty draft, and a concurrent draft change requeues the original input.

## Consequences

Pending input stays beside the draft and its controls remain reachable independently of conversation reading. Delivery removes the queue row by canonical message identity without an extra transcript bubble or empty spacer. A bounded queue can require internal scrolling, and expanded editing temporarily defers access to pending controls until collapse. The change adds no API, persistence migration or scheduling behavior.

Existing selector and recovery tests retain their lifecycle coverage. The real Dock/Composer browser regression adds placement, empty-state height, editing-space reservation, stable mode updates, async session isolation, first-task/rollback restrictions, narrow geometry and expanded-editor motion coverage. Direct component tests retain focused sibling rows during withdrawal and verify recovery action restrictions. Whole-page acceptance uses an isolated production Web origin and synthetic inference with the real backend and SDK; it does not establish native IME behavior or model quality.

Recovery browser fixtures hold request completion explicitly while asserting disabled controls, then release the operation to verify failure, retry and restored eligibility. They do not depend on observing a short timer window.

Inactive retained Sessions suspend both viewport and content observation and unmount their Composer; activation restores observation without discarding reading intent. Queue keyboard checks use the shared focus treatment so they remain aligned with global presentation.

The browser fixture composes the production Session layout, conversation presentation, viewport, content clearance, scroll controller and Dock at 375 and 1000 px. Late queue mounting after the settling window must keep an accepted latest intent at the bottom without transcript growth; a native upward wheel control must retain reading through mount and delivery. Frozen keyboard cases reach the final row with Tab and End. Chromium's implicit scroll-container focusability passes without an explicit target, while WebKit skips the same frozen list; both are checked without custom key handlers.
