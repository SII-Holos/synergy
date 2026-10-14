# Decision Record: Retained process viewport continuity

Status: implemented

## Problem

A retained conversation can keep its outer scroll owner while a nested process window loses its measured width and virtualized children when hidden. Restoring those children changes the transcript geometry. Independent process following and automatic collection can also animate background changes during reactivation, even when outer following waits for hydration.

## Decision

Process windows consume the shared view-activity context. Inactive windows disconnect layout, mutation and selection observers, cancel queued scroll work and retain their last positive width and reading intent. Activation measures the visible owner and restores its local anchor or latest position. Zero-width layout does not invalidate a resident virtualizer.

The conversation hydration owner supplies motion readiness through the shared conversation-motion context. Nested providers compose readiness with their ancestor. Process following and automatic collection apply restored state without animation until that owner is ready. Explicit disclosure and subsequent foreground activity retain their ordinary motion. No new content subscription, replay path or body request is introduced.

## Alternatives considered

**Keep only the outer scroll position.** An unchanged outer owner cannot preserve nested tool nodes or prevent their independent follow animation. Both viewport levels need lifecycle and painted-geometry coverage.

**Ignore zero width but keep background observers running.** This prevents one unmount path while continuing layout work and potentially replacing the reading anchor with hidden geometry.

**Disable process animation permanently.** Navigation recovery and foreground activity have different presentation needs. Sharing the existing hydration readiness retains foreground feedback without another timer or loading barrier.

## Consequences

Resident tool windows preserve their virtualizer and reading nodes across navigation and width changes. Hidden owners do no process layout work. Regression tests cover running and completed background activity, following and reading, automatic collection, request reuse and each painted frame; existing disclosure, history and live-follow tests protect foreground behavior. The view cache and body budgets remain unchanged. See [frontend data sync](../../../architecture/frontend-data-sync.md#retained-presentation-and-reconnect-validation) for ownership and [conversation verification](../../../../.synergy/skill/develop-frontend/references/conversation.md#conversation-navigation-motion) for the test workflow.
