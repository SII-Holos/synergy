# Decision Record: Task detail loading and dismissal

Status: implemented

## Problem

Opening Task details or its Inbox can replace an already-visible conversation and Composer with the Session page's loading fallback. Detail resource consumers are constructed under the Session owner before the Popover portal opens, so pending reads register with that outer Suspense boundary. Dismissing the Inbox also resets its navigation while the Popover is still animating out, changing the displayed title, body and height during exit.

## Decision

Workspace branch, Environment, scheduled activity and removed Inbox resources have explicit initial snapshots and latest-value consumers. Loading and error presentation remain local to those existing controls. Snapshots retain their resource ownership checks; the branch snapshot also carries Scope identity. Closing, leaving a subview or clearing its resource target aborts reads, while Session-owned Inbox operation state and in-flight mutations survive ordinary Popover dismissal.

Popover dismissal retains the displayed subview until its exit finishes. Navigation resets when the next opening begins. Reopening an exiting portal transfers focus to the revealed Inbox entry because the existing portal does not repeat its opening autofocus when its previously focused subview becomes hidden. Shared Popover animation and focus restoration retain ownership of Close, Escape, outside activation and trigger dismissal. Deferred restoration checks the opener's current expanded state after animation and frame waits, so an earlier dismissal cannot take focus from a newly opened Popover.

## Alternatives considered

**Wrap only the portal body in Suspense.** Resource consumers created before that body still inherit the Session boundary. This does not prevent the original page fallback.

**Dispose every detail controller on close.** Recreating these controllers would discard retained Inbox operations and snapshots. Cancelling reads and preserving the existing Session owner gives the request lifecycle its required boundary without replacing operation state.

## Consequences

The conversation, Composer draft and visible nodes survive pending detail reads and repeated dismissal. Latest snapshots require explicit identity checks before display; an initialized resource alone does not prevent a normal resource read from suspending during refresh. Retained controllers keep bounded metadata until their Session owner is disposed. Regression tests hold first and later requests under a real Suspense boundary, check cancellation and superseded results across resource deselection and Session navigation, preserve mutation reconciliation after dismissal, and sample actual browser exit frames plus focus restoration during rapid reopening. Shared focus tests cover controlled and uncontrolled Popovers as well as ordinary Escape, explicit anchors and plugin triggers.
