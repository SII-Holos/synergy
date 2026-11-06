# Decision Record: observe log changes before delivering the initial snapshot

Status: implemented

## Problem

The Link log follower delivered its initial content before reading the file size and installing its watcher. A write triggered by that first delivery could therefore advance the offset without ever being emitted. CI reproduced the missing append while validating the frontend plugin platform.

## Decision

Install the watcher before reading. Derive the offset from the exact bytes delivered, serialize reads and coalesce notifications received during a read into one pending read. An optional abort signal ends the follower and removes its process signal listeners; existing CLI signal handling remains available. A regression test appends synchronously from the initial callback and verifies both complete output and listener cleanup.

## Alternatives considered

Adding sleeps or increasing the test deadline would leave the unobserved interval intact. Concurrent reads could finish out of order and move the offset backwards. Polling would add a second observation mechanism without fixing snapshot ownership.

## Consequences

Initial tail/time filtering and subsequent append/truncation behavior stay intact. The follower does not emit after cancellation and keeps at most one pending read. Log rotation and rewrites that never shrink below the observed offset remain outside this change.
