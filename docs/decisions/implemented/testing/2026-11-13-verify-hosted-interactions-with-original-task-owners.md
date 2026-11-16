# Decision Record: Verify Hosted interactions with original task owners

Status: implemented

## Problem

A metadata fixture cannot establish how real Hosted model tasks retain private confirmations, admit another member's shared reply or recover after shutdown. Treating every interrupted task as a terminal cancellation would falsely claim resource release and lose the waiting task's identity.

## Decision

The Hosted interaction acceptance fixture enrolls two members and a real Hosted Home, uses HTTPS and the authenticated bridge, and produces native questions through actual model tasks. Public APIs decide replies and submit a later collaborator input. The fixture checks original creator/input attribution, private denial after the creator leaves, shared collaboration and genuine completed-root release.

Shutdown and reopening have separate assertions. A metadata-only cold open retains the interrupted private Run and its exact pending release intent without a fabricated receipt. A real listening reopen waits for an actual Service retention inspection and confirms the same held root, native pending state and unchanged model-call count. An interrupted resumable Run is not a cancelled Run.

The shared task-wait helper treats only the native missing-Run error as not-yet-materialized while accepted Inbox work schedules asynchronously. Its deadline and terminal/release checks remain unchanged; it never repeats input or swallows other Store errors.

The native always-permission fixture completes real Hosted work in Project P and reuses its saved target rules for Project Q on that Runtime. A separately enrolled Home receives the same native prompt and stores no rules after rejection. It verifies the original failed callback and idle Runtime while retaining the partial Run and pending release when another model call is still required. Explicit fixture finalization accepts only a genuine terminal native Root before closing its Runtime.

## Alternatives considered

**Mark interrupted private work cancelled to drain the fixture.** This changes product behavior and bypasses the original waiting task. The native owner requires genuine terminal and drainage evidence before release.

**Assert remote release after a metadata-only reopen.** No bridge or Service receipt exists in that mode. Retained pending evidence is the correct result.

**Retry accepted input when the Run has not appeared.** Acceptance and asynchronous Run materialization are distinct. Waiting must preserve the one original accepted effect.

## Consequences

The test proves actual interaction and recovery behavior without claiming real-model quality or copied-Home acceptance. Private waiting can retain resources across an interruption; only a genuine terminal owner can release that generation. Shared work still has a positive completed-release assertion.
