# Decision Record: Preserve retained conversation state and admit settled history

Status: implemented

## Problem

Retaining a transcript's DOM does not preserve its visible state when deactivation clears accepted execution results. A warm return can lose its completion footer while an unnecessary replacement read runs. Cold history has a separate gap: an initial scroll and available headers do not establish that bodies, execution-derived content and Markdown geometry are ready to paint. A mount-owned arrival lease also loses foreground ownership after another retained Session becomes active, suppressing genuine live arrivals on return.

## Decision

Separate execution ownership from request readiness and retained-view activity. Inactivity, pending preparation and temporarily missing Session metadata pause execution reads without discarding accepted state for the same server, Scope, client and Session. The read accessor preserves that accepted state independently of request eligibility. Reactivation drains roots from cancelled reads or independent invalidations; restored readiness validates the retained root window once. A failed refresh is not authoritative evidence of absence and does not clear accepted results or retry itself. Identity replacement, canonical root removal and accepted response omissions retain their existing invalidation semantics; an accepted empty root window retires states without requesting an empty batch.

Admit cold history only when its initial mounted reading window is settled, then reveal it statically. Keep the target shell, topbar, Composer and local loading status available during that wait. An admitted warm view and captured first-send content retain their continuity. Scope and cache eviction continue through the existing cold path rather than acquiring another restoration mechanism.

Canonical root execution states determine transcript completion. Task details accounting summaries are independent optional data: their pending, failed and cancelled reads cannot gate transcript admission or resumed layout hydration. A matching accounting summary can supply duration later without replacing the completion footer. Settled-message timestamps, copying and forking use their existing message eligibility independently of execution metadata. The outer footer and its action row share that eligibility; missing execution evidence never fabricates a completion label or hides otherwise available actions.

Keep visibility admission latched, but scope layout hydration to each active interval. Returning after background work reconciles mounted bodies without whole-transcript motion; motion becomes eligible only after frame measurement and ResizeObserver correction have delivered. Equivalent user-message reference arrays retain their rendered DOM through a value-stable key, preserving concrete paragraph anchors. A cached lease is not a current server checkpoint: the existing subscription generation must settle through the event queue before resumed motion becomes eligible. Acknowledgment changes only local readiness; it publishes no extra interest or request. Small terminal Markdown enriches changed blocks while preserving equal paragraph nodes and block whitespace, rather than replacing the entire body. These changes add no polling or eager content read.

Coalesce readiness notifications rather than restarting the frame window on every mutation, so continuous streaming cannot starve cold admission. Bind the live-arrival lease to active residency and document visibility, and its readiness to transcript admission. Hidden documents release pending receipts, including receipts received before a delayed body mounts. Historical restoration does not become a new arrival; only foreground live receipts authorize Part entrance motion. Resolve the activity projection's `passthrough` wrapper through the existing timeline helper before consuming a text receipt; transport acceptance alone does not establish that its renderer can use it. The exact predicates, cleanup and ownership rules live in [Frontend data sync](../../../architecture/frontend-data-sync.md#conversation-navigation-presentation), alongside [execution-state retention](../../../architecture/frontend-data-sync.md#tool-content-retention) and [arrival receipts](../../../architecture/frontend-data-sync.md#demand-driven-resources-and-content).

This partially supersedes [cold following](2026-10-12-cold-conversation-following.md)'s visible-during-settlement choice, [display admission](2026-10-07-session-switch-display-admission.md) and [rendering lifetime](../architecture/2026-10-07-conversation-rendering-lifetime.md)'s entrance fade, and [targeted execution invalidation](2026-10-07-targeted-conversation-execution-invalidation.md)'s failure clearing. Their remaining ownership, bounded preparation, following and request-coalescing decisions still apply.

Recovery revocation is refined by [Recovery motion ownership](2026-10-20-conversation-recovery-motion-ownership.md). Visibility admission, execution retention and source-classified live receipts retain the responsibilities described here.

## Alternatives considered

**Clear state on inactivity or refresh failure.** Neither condition proves that accepted execution evidence disappeared. Clearing creates a loading gap on a retained view and repeats reads even when no root changed.

**Treat missing request prerequisites as a new owner.** Preparation and metadata availability can change without changing the Session. Clearing accepted state or returning an empty value through the accessor exposes a refresh gap; retaining it within the existing bounded owner avoids another cache or fixed delay. Actual identity replacement still clears it immediately, including while reads are suspended.

**Keep cold history visible while correcting its layout.** Instantaneous following removes one animation source but still exposes incomplete bodies and execution-derived footer changes. Restricting the wait to the transcript preserves usable controls without painting intermediate history.

**Retain a transcript entrance fade or a mount-only arrival lease.** Navigation and historical restoration are not live content arrivals. A transcript fade animates accepted history; a mount-only lease cannot reacquire foreground ownership when the same mounted view returns.

**Reuse initial hydration forever or delay every return by a fixed timer.** An initial receipt says nothing about background changes. A timer cannot establish that delayed bodies and virtual measurements finished; resetting visibility would unnecessarily hide already-readable content.

**Wait for Task details accounting whenever its panel is open.** Its session-wide aggregation is independent of the mounted reading window. Waiting couples transcript visibility to panel latency and makes cancelling that read appear to repair the conversation. Root execution and body readiness already supply the evidence the transcript needs.

## Consequences

Cold transcript visibility waits for real dependencies rather than a fixed delay, so slow dependencies remain represented by local loading or existing failure UI. Offscreen history stays lazy. Warm views avoid execution-state reconstruction and retain footer geometry, while accepted state can remain stale until a later authoritative update. The change adds neither a global execution cache nor polling and does not change reading bookmarks or first-send identity.

[Conversation verification](../../../../.synergy/skill/develop-frontend/references/conversation.md#conversation-navigation-motion) owns the frame, request and keyframe checks. The [production browser suite](../../../../test/plugin-ui5/messages-browser.test.ts) verifies independent body/execution release order, first visible reading-window content, retained footer geometry and live Part keyframes after a warm switch. The [shared UI browser suite](../../../../packages/ui/test/components/conversation-motion.browser.test.ts) locks projected-text entrance, reading and reduced-motion suppression, and no remount replay. The missed title-only, projection and keyframe checks are recorded in the [cold hydration postmortem](../../../postmortem/0071-cold-conversation-hydration-motion.md#follow-up-retained-readiness-and-arrival).

The [background-return browser regression](../../../../apps/web/test/components/session/conversation-background-return.dom.test.ts) combines working/completed tasks, following/reading and immediate/delayed bodies. The [production acceptance](../../../../apps/web/test/fixtures/workbench/verify-background-return.ts) runs the complete application, generated SDK, inference stream and storage with frame capture and body-read counts.

Production cold-return frame checks include delayed neighbouring bodies and sample during rendering updates. They require complete visible content and stable viewport-relative body/footer geometry, while recording total scroll extent separately. Overscan preparation can change extent and scroll offset together without moving the reader's content; requiring both values to remain constant would reject correct compensation. Visible pending content and transient position changes remain failures under the same pixel threshold.

The [conversation owner regression](../../../../apps/web/test/components/session/conversation-row-retention.test.ts) holds a real execution-summary controller pending through cold admission and retained hydration, then fails and cancels its reads. It preserves root-execution readiness, transcript nodes and bounded request counts.
