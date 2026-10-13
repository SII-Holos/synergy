# Cold conversation hydration restarted following motion

## Executive summary

First-time Session navigation could visibly rebound even after retained views fixed warm switching. Following animation was admitted after message headers and an initial scroll correction, before lazy bodies and Markdown settled. Tests that inspected only the final position or started after readiness missed the disturbance. Animation eligibility now follows the initial mounted body's lifecycle while content remains visible.

## Summary

A production browser fixture held body responses, opened a 24-turn conversation in a narrow desktop message column and released a large final Markdown body. The same latest footer moved through more than 1,000 CSS pixels and the transcript faded during hydration. Returning to an already mounted Session remained stable.

## Timeline

- Retained Session navigation removed repeated mounting and warm entrance motion.
- A cold navigation recording still showed body expansion, displacement and rebound.
- Frame capture originally started after readiness and missed the correction. Moving capture before navigation reproduced a footer range of 1,013 CSS pixels with transient 0.65 opacity.
- Separating cold hydration from follow animation reduced the same fixture's range below 2 CSS pixels with full opacity.
- A later hosted run retained the footer geometry but caught the distant-follow fallback fading the transcript after a late correction. Deterministic large-growth and Latest-navigation controls reproduced 0.65 opacity. Those corrections now use immediate native positioning; ordinary short following motion remains covered.

## Root cause

Header admission enabled the viewport's transform/opacity following target. Deferred body materialization and Markdown parsing then changed virtual row heights. Canonical bottom corrections were correct, but each correction restarted a whole-transcript animation against temporary geometry. Final offsets were insufficient evidence because both faulty and corrected paths converged to the same bottom.

Initial virtual-row measurement remains necessary for new live rows. It cannot predict bodies not yet fetched or parsed, so it does not replace cold hydration admission.

## Guardrails added

- [Production browser test](../../test/plugin-ui5/messages-browser.test.ts): capture before readiness, delay actual content responses, parse large Markdown, assert per-frame position/opacity and retained DOM on warm return.
- [Conversation lifecycle test](../../apps/web/test/components/session/conversation-row-retention.test.ts): body and Markdown settlement, one-time release, late completion after owner replacement and later growth.
- [Decision record](../decisions/implemented/bug-fix/2026-10-12-cold-conversation-following.md) and [frontend workflow](../../.synergy/skill/develop-frontend/references/conversation.md#conversation-navigation-motion): distinguish visible shell readiness from following motion eligibility.

## Lessons

Sample the first visible geometry, not only the settled endpoint. Rendering cached views and hydrating a new view exercise different lifecycles. Keep loading local and make cold corrections instantaneous without removing ordinary live interaction feedback.
