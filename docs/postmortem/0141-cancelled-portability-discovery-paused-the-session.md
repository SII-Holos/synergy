# Cancelled portability discovery paused the Session

## Incident

Source preparation checked its signal before owner discovery. An asynchronous portability reader could finish after that original signal aborted. `selected()` returned its owner list and preparation wrote the native pause and draining intent before a later loop noticed cancellation.

## Root cause

The discovery callback accepted only Session metadata, and the caller did not recheck the original signal after its awaited result. Returning the correct abort error later did not undo the already published pause.

## Resolution

Owner discovery receives the original signal. `selected()` checks it immediately after every asynchronous contribution and before returning a successful selection to Source preparation. Environment history discovery preserves the original abort reason instead of converting it to a portability requirement.

## Verification

`packages/harness/test/session/transfer-environment-origin.test.ts` holds the actual Source discovery callback, aborts the original controller and releases the barrier. Before the fix, preparation returned the original reason but left `session.paused` set. After the fix, it returns that same reason with no pause or epoch hold. The first diagnostic timed out because its Promise matcher blocked the fixture before releasing the barrier; that timeout is not product-failure evidence. The corrected native Promise outcome produced the behavioral RED before the guard changed.

## Guardrail

Cancellation must be checked after an asynchronous pure preflight, before its caller publishes state. A reader returning does not prove its original request is still active. See [completed Environment history](../decisions/implemented/architecture/2026-11-12-transfer-completed-environment-history-through-native-owners.md) and the persistence Skill.
