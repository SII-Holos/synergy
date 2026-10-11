# Decision Record: Preserve focus chosen after Dialog closes

Status: implemented

## Problem

A closed shared Dialog schedules focus return on the next animation frame. A caller can resolve a replacement resource control in its close callback, and the user can then focus another control before that frame runs. Unconditional return to the captured opener overwrites the newer choice and sends the following Enter to the wrong action.

## Decision

The shared Dialog owner restores its captured opener only while the remaining top Dialog is unchanged, that opener is connected, and focus is absent, on the page body or disconnected. A connected non-body active element retains focus. This is recovery for lost focus, not a delayed navigation command.

Caller-owned dynamic focus targets remain resolved at close time, including resource controls replaced during Markdown terminal settlement. The shared owner does not cache those targets or add another caller timer. Stack replacement and detached openers keep their existing protections. The corresponding resource identity behavior remains in [Unified resource opening](../architecture/2026-10-08-unified-resource-opening.md).

## Alternatives considered

**Wait longer or retry the attachment reader test.** This avoids the observed interleaving without preventing fast keyboard users from activating the wrong resource.

**Change only the image preview's close callback.** The pending focus return is owned by the shared Dialog, so changing the caller cannot protect other consumers or a later user focus choice.

**Remove automatic focus return.** Normal close and stacked-child dismissal still need recovery when removing the Dialog leaves focus on the page body.

## Consequences

Explicit focus choices take precedence without additional timers, retries or persisted state. The deterministic Chromium regression holds animation frames, closes the real shared Dialog, selects the next control, releases the old frame and verifies native Enter activates only that control. Separate cases retain body-focus recovery, child-to-parent return, replacement Dialog ownership, detached openers, provider unmount and dynamic resource-control replacement. Existing attachment browser acceptance remains unchanged; local evidence does not establish platform CI or merge readiness.
