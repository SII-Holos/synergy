# Decision Record: Wait in the conversation column's own shape

Status: implemented

## Problem

A cold Session switch of a few hundred milliseconds painted three different shapes in sequence: the transcript, then a spinner and label centred in the viewport, then the transcript again. Each transition was instantaneous, and the middle shape had a different anchor and a different visual mass than the content around it. The reader's focus moved to the centre of the pane and was then pulled back out across a full column of text, which reads as a flash even when the wait itself is short.

The two admission surfaces — the page branch in `apps/web/src/pages/session.tsx` and the unadmitted viewport in `apps/web/src/components/session/conversation-viewport.tsx` — each held their own copy of the same centred `Spinner` and the same `sessionLoading` string. Presentation admission already allows a local loading status during the wait; nothing required that status to be a centred indicator.

## Decision

One component, `ConversationLoadingPlaceholder`, owns the cold-conversation waiting presentation, and both admission surfaces render it. It is absolutely positioned against the pane, reuses `.session-conversation-content .session-content-column` so its left edge and column width are the same as the transcript's, and draws only stacked line blocks whose widths follow paragraph rhythm and end short. The blocks start where the transcript's first row starts and repeat past the pane's bottom edge, clipped there: short history is laid out from the column top while long history resumes at its latest turn, so a shape anchored to either edge alone would move on the other case. It carries no body text; the existing `sessionLoading` string is exposed to assistive technology through a visually hidden `role="status"`.

The shape breathes through opacity only, staggered per line, with an explicit `prefers-reduced-motion` override that stops the animation and holds one opacity. No entrance or exit animation is added: a transition on a wait this short would introduce another visible change rather than remove one. The `delayed-loading` retry action renders inside the placeholder's column rather than beside a centred indicator.

The placeholder reports geometry, not progress. It does not measure the target Session's rows, does not claim a line count, and creates no timer, subscription or durable state. Admission predicates, `aria-hidden`/`inert` ownership and the `data-ready` contract are unchanged.

## Alternatives considered

**Keep the outgoing transcript behind the incoming one and cross-fade.** The user rejected this: during the fade two different transcripts are simultaneously semi-visible, so their text overlaps. Overlapping prose is worse than an instantaneous swap, and the fix would trade one visual defect for a larger one.

**Keep the centred spinner and only soften its timing.** The problem is not the indicator's own animation but its anchor and mass relative to the content. A shorter or gentler spinner still concentrates attention at the centre and then releases it across the column.

**Show nothing at all during the wait.** A silent surface avoids the second shape, but it also removes the only local evidence that navigation was accepted, and the existing decision to keep a local loading status during preparation would be undone. An empty column also gives no indication of where the content will appear.

**Measure the target Session's real rows and reserve their exact height.** Exact geometry would need message metadata before admission, which is the work admission is waiting for. It would also turn a presentation concern into a new data dependency on the cold path.

## Consequences

The reader keeps one focus and one anchor across the wait: the waiting shape becomes the transcript's shape rather than being replaced by it. The wait is still visible and still bounded by the same admission predicates, so a slow dependency remains represented rather than masked.

The placeholder's paragraph rhythm is authored, not measured, so its line count and break points do not match the arriving transcript. Placement, column geometry and bottom anchor do match, and the arrival is a static reveal at the same position, which is what removes the perceived jump.

The two former indicator copies collapse into one component, so a future change to the waiting presentation cannot diverge between the page branch and the viewport.

[Conversation verification](../../../../.synergy/skill/develop-frontend/references/conversation.md#conversation-navigation-motion) owns the frame checks. The [placeholder regression](../../../../apps/web/test/components/session/conversation-loading-placeholder.dom.test.ts) mounts the real viewport with real workspace styles and asserts, against the arriving transcript, equal column left edge and width, no body text in the placeholder, a first line whose optical centre matches the admitted first paragraph, a last line past the pane's bottom edge, and a still shape under reduced motion.
