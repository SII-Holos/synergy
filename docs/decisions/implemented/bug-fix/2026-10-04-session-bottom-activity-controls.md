# Decision Record: Restore bottom session activity controls

Status: implemented

## Problem

Moving execution information into the upper toolbar also removed the bottom subagent avatars and expandable Todo/DAG progress. Their data and product interaction contracts remained, but users lost direct access to child Sessions, hold-to-cancel and the progress graph while working in the Composer.

## Decision

Mount `SubagentDock` and `SessionProgressPanel` in the existing Composer priority outlet. Task details retains its own ownership and implementation. The bottom controls consume canonical Session data and runtime events without a Workbench capability gate or new API.

Keep avatars above the exclusive summary slot. A workflow offer temporarily hides and collapses progress while retaining and freezing its DAG instance. Position the expanded panel above the entire activity group, constrain it to the shared conversation column and viewport, and scroll its content internally. When the anchor leaves insufficient reading space, the same retained content uses a dismissible modal reading surface with the shared focus boundary. Close and Escape return to the summary; request and editor state stay intact. This avoids a viewport-constrained panel shrinking to an unreadable strip.

Reserve the measured activity height and minimum request chrome when sizing the normal Composer. Header and action rows, body padding and the card gap must remain available while request content scrolls, including when permission actions wrap. Expanded editing temporarily hides the retained bottom controls and inline requests so the editor can use the full conversation height without pushing Send outside the viewport. Collapse restores them and their drafts. Because priority and Composer contributions mount independently, observe the local rendered editor flag, including late mounts. Expansion aborts outstanding avatar holds and collapses and freezes progress without discarding pending cancellation or the graph. Make the reading surface visible before assigning initial focus; a visibility transition can otherwise reject focus during its first frame.

Retain the view content independently of its normal or modal container. Mount the shared modal content only during expanded reading so a collapsed progress surface cannot pause another dialog's focus scope. Track its actual panel element for execution-end focus return, including when that element is portalled.

Use the visible viewport's dimensions and offsets for modal bounds so zoom or an on-screen keyboard cannot place the reading surface beyond the area the user can see.

Constrain the DAG canvas to the panel's actual flexed reading height before its initial fit, including at browser zoom when the tab row wraps. A canvas taller than its clipped body can center every node outside the visible area even though the toolbar and node controls exist. Reconnect floating positioning when sibling requests move the retained anchor without changing its size; cached available height must not survive a viewport or request-layout change.

Treat activation and cancellation as distinct gestures. Running avatars open the child Session through canonical navigation; a two-second pointer or Space hold requests cancellation once. Movement, cancellation, lost capture, blur, Escape, Session changes and completion invalidate the gesture. Retain pending avatars until authoritative state changes, and expose request failure with retry available.

Todo remains read-only and fully wrapping. DAG retains node details, readiness, selection, child navigation and manual viewport across collapse or tab switches. Observed execution end keeps the receipt for 1.6 seconds plus the 180 ms exit; parent and child waits, pause, unknown status and disconnection preserve it. Initial idle history does not replay progress. Removal returns contained focus through the existing Session focus owner.

This supersedes the progress-retirement decision in [integrated session surface cleanup](2026-10-03-integrated-session-surface-cleanup.md) only. Its Task details, request collision and conversation focus decisions remain in effect.

## Alternatives considered

**Use task details as the only execution surface.** It removes the direct child-session and cancellation gestures and the expandable progress view the bottom controls provide.

**Restore the previous mounts unchanged.** It leaves cancellation failures silent, permits navigation after interrupted holds and positions progress over the avatar strip.

**Unmount the graph whenever hidden.** It discards manual viewport and selection state when switching views or accepting a workflow offer.

## Consequences

The bottom surfaces and task details coexist with separate interaction responsibilities. Behavioral browser coverage checks the actual bottom mount, navigation and hold cancellation, failure/retry, hidden graph retention, lifecycle and narrow geometry. Real-provider acceptance uses a separate home and the production Web build to exercise requests and Composer resizing together.
