# Decision Record: Settle cold conversation layout before animated following

Status: implemented

## Problem

Resident Session views made warm navigation continuous, but the first body load could still move and fade the entire transcript. Header readiness and an initial scroll correction did not mean lazy bodies or asynchronous Markdown had finished changing virtual geometry. Following interpreted those corrections as new activity and repeatedly animated the cold layout.

## Decision

Keep initial positioning and following animation admission separate. The mounted conversation reports hydration once its current row body leases settle, non-streaming Markdown is no longer pending, fonts are ready and mutations/resizes have left two animation frames for layout measurement. During this interval, canonical bottom corrections are instantaneous and target content remains visible and operable. The callback is tied to the mounted owner, observes only the current surface, and releases its observers on completion, inactivity or disposal. A replacement viewport resets animation eligibility. A retained hydrated viewport and later live growth preserve ordinary following motion.

The shared Markdown renderer exposes its asynchronous pending state as a DOM attribute, without adding a visual loading barrier. This avoids coupling Session navigation to the parser implementation or fetching offscreen bodies.

## Alternatives considered

**Disable all following animation.** It removes useful feedback during subsequent generation and does not distinguish cold geometry correction from new content.

**Wait before showing the conversation.** It restores the disruptive whole-area loading barrier and delays usable content and controls.

**Use a fixed delay or only header readiness.** Body/network latency and Markdown work vary; either can finish after the arbitrary deadline.

## Consequences

Only the initial mounted window participates; offscreen history remains lazy. Content failures can settle into their existing retry UI. This changes presentation timing without changing message identity, body cache ownership or transport semantics. Continuous cold activity can postpone animated following while canonical following and interaction remain usable.

The [production browser regression](../../../../test/plugin-ui5/messages-browser.test.ts) captures frames from the first bottom pin through delayed bodies, large Markdown and warm return. The [owner lifecycle regression](../../../../apps/web/test/components/session/conversation-row-retention.test.ts) verifies pending bodies and Markdown, one-time release and stale owner rejection. [Postmortem](../../../postmortem/0071-cold-conversation-hydration-motion.md).
