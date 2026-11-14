# Decision Record: Cancel native activation before epoch publication

Status: implemented

## Problem

Native aggregate activation waited on epoch locks without observing cancellation. Its final pointer writes also followed the owner's publication callback without a cancellation check at commit. A connection could therefore close while its queued activation remained live or its paused publication still committed.

## Decision

`SessionTransferEpochs.activateMany()` accepts an optional caller signal. It snapshots the validated manifest hash, original signal and publication callback before its first await. It observes that signal before acquiring locks, abandons each cancelled lock waiter and registers every acquired lock for disposal before checking a simultaneous abort. Cancellation is rechecked at the write transaction's entry, after the publication callback and in the actual Storage commit guard. The destination controller passes its connection lifetime into this owner.

These checks stay inside the existing native epoch owner. The caller does not open a Storage transaction and then wait on epoch locks. A cancellation before commit rolls back the complete paused publication and retained activation receipt; a committed activation remains an immutable outcome that must be inspected rather than automatically replayed or reversed.

## Alternatives considered

**Check only after the controller returns.** That reports an error after its canonical publication has already committed.

**Wrap activation in an outer transaction with a cancellation guard.** Waiting for epoch locks while holding SQL admission reverses the owner's lock order.

**Release a queued waiter's lock later without removing it.** The abandoned waiter can run after the connection has closed and publish unobserved state.

## Consequences

`test/session/transfer-activation-cancel.test.ts` holds an actual epoch lock and requires cancellation to settle before releasing it. A separate real Storage mutation guard aborts during the final current-pointer write; the transaction leaves no canonical Session and its reservation remains prepared. Held-lock cases also mutate the caller's manifest, callback and signal; publication keeps its original inputs and cancellation keeps its original reason. Existing permanent surrender, returning activation and retirement alternatives remain covered. See the [incident](../../../postmortem/0107-native-activation-outlived-cancellation.md).
