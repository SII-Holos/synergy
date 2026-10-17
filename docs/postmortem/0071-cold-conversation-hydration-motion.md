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

## Follow-up: retained readiness and arrival

The October 13 follow-up found that the earlier footer-position and opacity checks did not establish a settled first visible reading window. A title-only interval before the sampled footer and delayed execution-derived footer changes were outside that evidence. The earlier result also did not establish that a genuinely new Part retained its original opacity-only keyframes after a warm return. Static history and live arrival need separate assertions; an eventually populated body or any observed animation cannot stand in for either.

The same 37 KB Markdown body also demonstrated that offscreen block virtualization legitimately leaves only part of the text in the DOM. Full-body DOM equality was therefore the wrong admission oracle, not evidence of missing content. The corrected checks use the loaded reading window's text source, its End sentinel and per-frame geometry.

The follow-up separates retained execution state from inactivity, waits for cold reading-window readiness and reopens the arrival lease on activation. Continuous streaming exposed an admission starvation risk when every mutation restarted the two-frame wait; coalesced scheduling releases admission without waiting for streaming to pause. Hiding the document also releases pending receipts rather than leaving an unconsumed entrance for return. This replaces the visible-during-settlement choice described above without replacing bookmark behavior or ordinary following. Rationale and partial supersession are recorded in [Retained conversation readiness](../decisions/implemented/bug-fix/2026-10-13-retained-conversation-readiness.md).

The production live-arrival probe still failed after lease ownership was corrected. Transport tracing confirmed an accepted live renderable summary and a ready foreground receipt, but the actual activity projection wrapped its text Part as `passthrough`. The renderer accepted only direct `part` items, so it never consumed the receipt. Reusing the existing timeline unwrapping helper fixed the missed path. A real SessionTurn browser regression first observed opacity 1 without an entrance, then verified the 180ms opacity-only fade, unchanged preceding prose and no remount replay. Reading and reduced-motion suppression retain consumption semantics.

The [browser regression](../../test/plugin-ui5/messages-browser.test.ts) adds independent body/execution holds, sampling before navigation, first-visible reading-window and footer checks, and inspection of live-arrival keyframes after warm return. The [verification workflow](../../.synergy/skill/develop-frontend/references/conversation.md#conversation-navigation-motion) also requires local loading and usable target controls.

The [presentation DOM suite](../../apps/web/test/components/session/conversation-presentation.dom.test.ts) switched to the existing `createBrowserFixture` after repeated Vite-development first-navigation failures at its five-second timeout. All four built-fixture cases passed, but they did not establish production acceptance. After the projected-text fix and a fresh production Web build, the complete production browser file passed all eight cases and 1,719 assertions, including both cold dependency orders, retained footer geometry, the real live Part entrance, history paging and reconnect. The shared UI motion suite passed all eleven cases and 113 assertions; the new text entrance case had failed before the fix with opacity 1 and no animation.

## Follow-up: background work during retained navigation

The earlier switching checks returned to settled transcripts and sampled final scroll geometry. Live-generation checks stayed in one Session. Neither exercised a hidden task growing before return. A mount-lifetime hydration receipt remained valid after inactivity, allowing historical catch-up to animate the whole transcript. A second race published readiness in RAF before ResizeObserver pinned the newly measured virtual layout. Equivalent user Markdown reference arrays also retriggered innerHTML replacement, disconnecting paragraph anchors despite identical content.

The combined browser regression was red for running and completed background tasks in following and reading modes. It measures actual transform and paragraph geometry each frame, holds changed bodies and counts unchanged reads. Layout readiness now renews per active interval and publishes after resize delivery; admitted visibility remains latched. A value-stable Markdown key retains unchanged DOM. The [readiness decision](../decisions/implemented/bug-fix/2026-10-13-retained-conversation-readiness.md) and [conversation verification](../../.synergy/skill/develop-frontend/references/conversation.md#conversation-navigation-motion) own the durable rules.

The complete production path additionally exposed a cached lease resolving before its renewed WebSocket checkpoint reached the event queue, and terminal Markdown replacing equal paragraphs because heading attributes and inter-block whitespace differed. Generation-fenced local checkpoint readiness and equal-block retention close those gaps without additional transport publication. Production frame capture reproduced whole-surface offsets of 702–736 pixels before these corrections and zero offsets afterward; history paragraph nodes and positions remain retained.
