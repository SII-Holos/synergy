# Decision Record: Observe shutdown and dialog transitions before continuing

Status: implemented

## Problem

The storage escalation integration fixture polls the real health endpoint after killing the SQLite writer. A successful fast shutdown can close the transport and exit before that poll observes the intermediate 503 response, leaving the admission marker absent even though the process exits with the required failure status.

The Review layout fixture sends Escape as soon as its version dialog becomes visible. Visibility can precede the dialog's initial focus, so keyboard input can still reach the closing menu and leave the dialog open.

Project settings fixtures similarly send Space to a folder checkbox before the nested picker has received initial focus. Deferred focus can redirect that input and leave the selection empty.

## Decision

Hold the fixture's runtime close operation behind a promise until the real health endpoint reports 503. Then release the original close operation and retain the independent process-exit marker and operating-system status assertions. The product shutdown watchdog and the fixture deadlines remain unchanged.

Before sending Escape in the Review fixtures, observe that focus entered the visible dialog. Then require its removal and the existing return-focus assertion. Move the pointer away after the copy action before exercising keyboard-only menu reopening, so pointer hover cannot compete with keyboard focus. Keep the production menu, dialog providers and animations.

Apply the same focus admission to the nested folder picker before keyboard selection, and assert the checkbox is selected before committing the folders.

## Alternatives considered

**Retry the failed CI jobs.** This can hide the races without establishing the transitions.

**Increase timeouts or accept missing observations.** A process that already exited cannot produce the missing marker, and a visible dialog does not establish keyboard ownership.

**Change product lifecycle behavior.** The observed failures arise from the fixture's timing assumptions; the existing admission, shutdown, focus and exit contracts remain required.

## Consequences

Both fixtures observe the required intermediate state before allowing the next transition. Neither relaxes a product assertion, extends a deadline or changes published runtime code. Focused stability runs and the hosted CI matrix verify the corrections.
