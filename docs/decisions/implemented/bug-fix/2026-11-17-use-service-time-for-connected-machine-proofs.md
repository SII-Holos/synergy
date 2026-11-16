# Decision Record: Use Service time for connected machine proofs

Status: implemented

## Problem

A machine can have a different wall clock from its Service. A real enrolled Target whose Native clock was advanced by 999ms produced a validly signed, unexpired 30-second execution proof that the original Service rejected as future-dated. Signing, client queue checks and later capabilities must use one time domain without widening authorization windows. Independent Continue acceptance does not prove that subsequent execution authorization succeeds.

## Decision

The current authenticated WSS handshake, heartbeat acknowledgement, command and command-chunk schemas carry the Service's actual send time. Client frames and command payload bytes retain their existing schemas. The client records monotonic arrival time before its receive queue and advances validated observations through queue delay. Its private connection clock only moves forward, rejects invalid arithmetic and expires with the original connection lifetime. Fresh current-bound signed Gateway permits can also advance that clock after tuple and signature verification. A repeated command never restarts its original permit deadline.

Command intake, connected handoff controllers, execution and business Gateway proof producers, resource-client checks and release uncertainty use that connection clock. Original 5-second plans, 15-second request/object limits and 30-second proofs retain their values and all identity, binding, role, signature and cancellation checks. Accepted handoff object callbacks retain their explicit operation clock. Native event dates, stored proof bytes, Home readers and offline HTTP recovery owners retain their existing representation.

Model worker context contains only numeric time observations and the exact capability Runtime, epoch and call ID. The parent's epoch coordinate measures transfer age on the same Host. The worker rejects invalid age, then advances the Service observation with its own monotonic elapsed time. Neither VM-relative `performance.now()` nor this Bun version's VM-relative `hrtime` is a shared cross-process epoch; the authoritative implementation retains the upstream source reference. A Host clock change between VM origins can cause rejection or an inaccurate age estimate; the original Service capability gate remains decisive.

These frame and transient context schemas are introduced by this unmerged feature. Required time fields define the current Service/Runtime cohort; missing fields do not fall back to Native time. No persisted-state migration or historical re-signing is needed.

## Alternatives considered

**Allow future proofs or increase validity durations.** This changes authorization rather than fixing its producer and leaves queue and capability checks in different domains.

**Anchor only to a Command permit.** An active root can reconnect without a new delivery. A connection must establish its own current observation.

**Use a VM-relative timer across workers.** Its origin differs between processes. Worker JSON needs a validated same-Host age coordinate, followed by local monotonic advancement.

**Patch one proof per CI attempt.** Execution, Gateway, handoff and release checks on the same live chain share this cause and must be verified together.

## Consequences

The connection estimate is a conservative continuation of received Service facts, not independent authorization or a guarantee against arbitrary clock changes. The original Service remains the authority for expiry. Tests offset only the actual Native owner while leaving the Service clock unchanged, retain real signatures and cover the complete native roundtrip with one persistent Target offset. The original two-OS roundtrip remains separate required acceptance; a same-platform counter cannot establish its result or the unique cause of an earlier opaque CI error.
