# Decision Record: Host Session execution admission

Status: implemented

## Problem

An embedded control plane owns current execution authority independently of persisted Session and Inbox state. Session driving could enter a loop or repair interrupted work without checking that authority, including automatic wakes after restart.

## Decision

Composition can register one Runtime-owned SessionExecutionSource. The host authorizes each Session, including children, before loop resource admission. Automatic wake also checks before settling interrupted work. Denial releases the local loop claim without scheduling more work, retains accepted Inbox input and stops that wake chain. Cancellation during authorization remains cancellation. Hosts use oneshot composition for a long-lived embedded worker whose recovery and resident services they control; recording recovery under exclusive namespace ownership remains distinct from executing pending work.

## Alternatives considered

Checking only transport commands misses Cortex children and automatic wakes. Deleting rejected Inbox items loses accepted work. Treating lease denial as a retryable scheduling failure can change an unowned invocation or run repeated attempts. Disabling all recovery would lose committed recording reconciliation.

## Consequences

Host admission fails closed and requires an explicit new drive after authority is restored. Hosts still fence and drain work when an admitted authority later expires. Default compositions retain their current admission behavior without a second Session lookup. Tests prove denial before execution, queued-input retention, no automatic retry, child admission, independent Runtimes and sealed registration.
