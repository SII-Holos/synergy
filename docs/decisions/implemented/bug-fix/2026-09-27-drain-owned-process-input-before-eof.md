# Decision Record: Drain owned process input before EOF

Status: implemented

## Problem

An owned process receives input through a private socket while a separate control message declares its final byte count. Receiving that count does not establish that the child process pipe has accepted the same bytes. Bun's child-process writable fast path can acknowledge socket delivery before its pending native writes finish, so ending stdin at that point can truncate input.

## Decision

The native worker forwards input through one bounded Writable and counts bytes only after the destination's write callback succeeds. EOF closes the destination only when its acknowledged bytes reach the declared count. The same forwarding path handles ordinary processes and PTYs, and accepts the EOF control message before or after input without buffering the complete body. A failed write closes upstream input and never converts the failure into a successful EOF.

The implementation records its Bun source provenance beside the forwarding code. Tests hold a destination write behind an explicit acknowledgement, exercise empty and late EOF, and compare byte counts and SHA-256 for socket-fed child processes through pipe boundaries and fragmented 16 MiB input. Existing native ownership, process cancellation, output drainage and installed-worker verification remain required.

## Alternatives considered

**Count socket data events.** Those events prove reception by the worker, not completion of the child pipe write.

**Delay EOF or retry the command.** A delay has no relation to actual backpressure, and replaying an arbitrary command can repeat side effects.

**Buffer the entire input or replace the process protocol.** Neither is needed to preserve the existing byte-count protocol; both add memory or compatibility costs.

## Consequences

The worker retains a bounded pending write and preserves the existing process ownership and stream protocol. Tests establish byte integrity independently from successful exit codes; cancellation may intentionally discard pending input after the owned command is stopped.
