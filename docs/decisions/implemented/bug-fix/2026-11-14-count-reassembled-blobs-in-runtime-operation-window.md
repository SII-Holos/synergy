# Decision Record: Count reassembled blobs in the Runtime operation window

Status: implemented

## Problem

A valid native attachment upload splits each authenticated 4 MiB chunk into ordered transport frames. Charging each fragment to the sixteen-operation receive queue closes the current socket before the logical chunk can reach its domain owner. Raising queue capacity would retain unnecessary work and leave partial transfers without an aggregate decoded-byte bound.

## Decision

The Service assembles strict contiguous blob fragments at the authenticated current socket before queuing one complete logical chunk. Partial groups and queued operations share the existing sixteen slots. All partial, queued and in-flight blob bodies share a separate decoded-byte charge of 4 MiB; the existing encoded-frame byte window also remains in force. The accepted chunk retains its charge until the original operation finally settles. Closing or replacing a socket immediately discards only incomplete groups, and closed queued chunks never dispatch.

Assembly checks the original capability, schema, epoch, canonical encoding, tuple, fragment order and body limit. It performs no domain write and emits no blob acknowledgment. The original queued operation captures the current connection and calls the sharing owner, which retains Session authorization, generation, offset, integrity, commit and acknowledgment checks. Client per-frame limits remain distinct from its shared socket-buffer limit, and bulk uploads yield enough buffer space for control frames.

## Alternatives considered

**Increase the operation window or heartbeat deadline.** This hides valid fragment fan-out without bounding retained logical bodies or correcting the ownership of the operation slot.

**Acknowledge transport assembly.** Having all bytes does not establish current Session authority or a committed blob. Only the existing domain result can authorize the acknowledgment.

**Release completed byte charges on socket close.** The original queued or in-flight operation still retains its body and must own its charge through final settlement.

## Consequences

Real enrolled WSS acceptance transfers an 8 MiB plus seventeen-byte native artifact in three original chunks and verifies the authorized download digest. Signed-peer regressions cover partial transfers without domain calls or acknowledgments, strict tuple/order/encoding checks, aggregate limits and replacement behind an in-flight operation. The full joint capacity workload requires its own result; this attachment regression establishes no product quota or total-memory bound.
