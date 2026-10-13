# Decision Record: Preserve retained conversation state and admit settled history

Status: implemented

## Problem

Retaining a transcript's DOM does not preserve its visible state when deactivation clears accepted execution results. A warm return can lose its completion footer while an unnecessary replacement read runs. Cold history has a separate gap: an initial scroll and available headers do not establish that bodies, execution-derived content and Markdown geometry are ready to paint. A mount-owned arrival lease also loses foreground ownership after another retained Session becomes active, suppressing genuine live arrivals on return.

## Decision

Separate request identity from retained-view activity. Inactivity pauses execution reads without discarding accepted state; reactivation drains roots from cancelled reads or independent invalidations. A failed refresh is not authoritative evidence of absence and does not clear accepted results or retry itself. Identity replacement and canonical root removal retain their existing invalidation semantics.

Admit cold history only when its initial mounted reading window is settled, then reveal it statically. Keep the target shell, topbar, Composer and local loading status available during that wait. An admitted warm view and captured first-send content retain their continuity. Scope and cache eviction continue through the existing cold path rather than acquiring another restoration mechanism.

Coalesce readiness notifications rather than restarting the frame window on every mutation, so continuous streaming cannot starve cold admission. Bind the live-arrival lease to active residency and document visibility, and its readiness to transcript admission. Hidden documents release pending receipts, including receipts received before a delayed body mounts. Historical restoration does not become a new arrival; only foreground live receipts authorize Part entrance motion. Resolve the activity projection's `passthrough` wrapper through the existing timeline helper before consuming a text receipt; transport acceptance alone does not establish that its renderer can use it. The exact predicates, cleanup and ownership rules live in [Frontend data sync](../../../architecture/frontend-data-sync.md#conversation-navigation-presentation), alongside [execution-state retention](../../../architecture/frontend-data-sync.md#tool-content-retention) and [arrival receipts](../../../architecture/frontend-data-sync.md#demand-driven-resources-and-content).

This partially supersedes [cold following](2026-10-12-cold-conversation-following.md)'s visible-during-settlement choice, [display admission](2026-10-07-session-switch-display-admission.md) and [rendering lifetime](../architecture/2026-10-07-conversation-rendering-lifetime.md)'s entrance fade, and [targeted execution invalidation](2026-10-07-targeted-conversation-execution-invalidation.md)'s failure clearing. Their remaining ownership, bounded preparation, following and request-coalescing decisions still apply.

## Alternatives considered

**Clear state on inactivity or refresh failure.** Neither condition proves that accepted execution evidence disappeared. Clearing creates a loading gap on a retained view and repeats reads even when no root changed.

**Keep cold history visible while correcting its layout.** Instantaneous following removes one animation source but still exposes incomplete bodies and execution-derived footer changes. Restricting the wait to the transcript preserves usable controls without painting intermediate history.

**Retain a transcript entrance fade or a mount-only arrival lease.** Navigation and historical restoration are not live content arrivals. A transcript fade animates accepted history; a mount-only lease cannot reacquire foreground ownership when the same mounted view returns.

## Consequences

Cold transcript visibility waits for real dependencies rather than a fixed delay, so slow dependencies remain represented by local loading or existing failure UI. Offscreen history stays lazy. Warm views avoid execution-state reconstruction and retain footer geometry, while accepted state can remain stale until a later authoritative update. The change adds neither a global execution cache nor polling and does not change reading bookmarks or first-send identity.

[Conversation verification](../../../../.synergy/skill/develop-frontend/references/conversation.md#conversation-navigation-motion) owns the frame, request and keyframe checks. The [production browser suite](../../../../test/plugin-ui5/messages-browser.test.ts) verifies independent body/execution release order, first visible reading-window content, retained footer geometry and live Part keyframes after a warm switch. The [shared UI browser suite](../../../../packages/ui/test/components/conversation-motion.browser.test.ts) locks projected-text entrance, reading and reduced-motion suppression, and no remount replay. The missed title-only, projection and keyframe checks are recorded in the [cold hydration postmortem](../../../postmortem/0071-cold-conversation-hydration-motion.md#follow-up-retained-readiness-and-arrival).
