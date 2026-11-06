# Browser view completed without frontend presentation

## Executive summary

The Browser view tool reported a shown workspace while the frontend did not open it. A workbench refactor removed the mounted metadata consumer, but the tool and its helper tests remained. The replacement uses one confirmed Workbench presentation path instead of restoring unacknowledged transcript side effects.

## Summary

A completed `browser_view` show call returned a ready Browser host and unknown workspace visibility. Its title said the workspace was shown. The user observed no frontend response. Browser page availability and a successful backend tool return did not establish that any client processed the display request.

## Timeline

- 2026-10-02: `4da255901` replaces `BrowserViewEffects` with the general workbench output observer. The replacement does not consume Browser view commands.
- 2026-10-21: A user reports a completed show call without a visible panel. The persisted result confirms a show request and unknown visibility.
- 2026-10-21: Read-only investigation finds no production caller of `applyBrowserViewCommand`. Replaying the real result through the current output mapper produces no resource; a Note creation control produces one, and direct invocation of the orphaned helper produces an open call.
- 2026-10-21: The approved correction introduces confirmed, directed Workbench presentation and removes the Browser-specific executable tool.

## Root cause

The frontend effect was the only consumer of an implicit command encoded in tool-result metadata. Its deletion did not change the backend tool's apparent success. Remaining tests invoked the helper directly and therefore could pass without any mounted application consumer. The backend had no client identity, dispatch acknowledgement or frontend execution receipt with which to distinguish a sent request from an applied view change.

## Guardrails

- Execute display requests outside transcript rendering and historical hydration.
- Require an eligible target connection and a matching frontend execution receipt before reporting an applied view.
- Exercise the registered tool and actual connected executor; an absent handler must not yield success.
- Cover late selection, wrong-client acknowledgement, duplicate calls, disconnect and reconnect without replay, focus and protected drafts.
- Preserve helper tests for local logic without treating them as end-to-end evidence.

## Lessons

A function that can open a panel is not evidence that the application calls it. Backend completion and host readiness cannot establish frontend presentation. The [presentation decision](../decisions/implemented/architecture/2026-10-21-confirmed-workbench-presentation.md) records the structural correction rather than adding another metadata consumer.
