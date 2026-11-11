# Decision Record: Dispatch finite handoff actions and seal private object closures

Status: implemented

## Problem

Persisted handoff facts cannot make a Runtime freeze or import native history. Reusing input admission for these actions risks replaying a task after a lost response. A private content hash also does not prove that its bytes belong to the selected handoff package.

## Decision

The service exposes an explicit drive operation for an already stored handoff. It derives canonical source ownership, reserved epochs, mapping revision, command watermark and machine identity from that record and the Directory. Initial preparation requires both current participants to advertise the actual handoff callback before locking the Session or consuming an epoch. Current account access, destination consent, phase and connection capability gate dispatch. A separately signed, finite machine plan binds those values to one operation and live connection. Surrender and activation additionally carry their independently persisted permits. This path cannot submit input or Continue and allocates no command sequence or input receipt.

The existing bounded command transport carries handoff exchanges in its reconciliation/read capacity. A native connection advertises handoff support only when its controller callback exists. It verifies the service signature, deployment, connection and validity window before calling that owner, signs returned durable facts with its machine key and checks their binding and required completion purpose. The service reconciles those facts through the existing fact owner and reauthorizes the caller after the response. An uncertain send stays unknown; a later explicit inspection does not replay the original action.

The Runtime's private object owner stores immutable, checksummed frames through canonical prepared Storage binaries. Its versioned namespace binds organization, deployment incarnation, handoff, participant role and exact native epoch tuple. A live handle also binds the actual Runtime, Store, artifact directory and object-backend configuration; another Storage context in the same Runtime cannot reuse it. Frames have a bounded size; object count and aggregate bytes have no product quota. A successful source package alone is insufficient for reads: the owner fully consumes the native streamed package and records its exact reachable objects before publishing a sealed marker. Range reads require that marker, matching current frozen or surrendered source ownership and closure membership, and verify the selected frame's bytes again. Failed preparation's unreachable objects, another Session or deployment and arbitrary hashes remain inaccessible. Range reads return at most 128 KiB; they read at most one bounded native frame, without rescanning an aggregate prefix.

Organization member and hosted main compositions register Core, evidence, Snapshot and organization command portability owners explicitly. This does not enable unrelated personal workflow components or install a permissive organization Asset authority.

The destination connection signs each bounded object request with its private machine key in a separate protocol domain. Its proof binds the current connection, full handoff tuple, sharing generation, frozen manifest and exact range to a fresh finite window. The machine-only service route rejects browser credentials, resolves the stored consent and current participant/project authority, and relays a service-signed object operation to the source. That operation carries an explicit system actor identifying the destination machine; it cannot impersonate a human command. The service rechecks both live connections, ownership and access after the source response and retains no content body. A long copy obtains fresh authorization for every range instead of extending the initial drive plan indefinitely.

The receiver verifies contiguous ranges, total length and the complete native frame digest before retaining that frame through the destination object owner. Native streamed staging consumes those retained frames while canonical Session publication remains separate. Each frame remains bounded; package size has no quota. A missing frame can be fetched, while corrupt retained bytes remain an error and cannot silently fall back to the source. Prepared binary producers may read their own destination cache; canonical Storage spools them outside its artifact gate before adopting and pinning the verified output under that gate.

## Alternatives considered

**Replay the original input after timeout.** A machine may already have committed its hold or surrender; a new input would create an unrelated effect and destroy recovery semantics.

**Trust any hash retained under the handoff directory.** Interrupted exports can leave bytes that the final package does not reference. Complete verified traversal determines the readable closure.

**Advertise capability from package presence.** A machine without the actual callback cannot execute the protocol and must not be selected as a controller.

**Build an in-memory object inventory or whole-package response.** Their memory use grows with retained history. Independently addressable native objects and closure rows preserve bounded frames and restart recovery.

## Consequences

Protocol and service fixtures verify real signature domains, strict operation/connection binding, required completion facts, current consent, post-response revocation and unknown-result inspection without input allocation. A generated HTTPS client reaches a real verified WSS native callback; actual Core preparation remains blocked without physical writer evidence, while actual native epoch cancellation returns a machine-signed fact accepted by the service. Object fixtures exercise real Source preparation, full closure verification, cold Runtime reopening, cancellation, aborted readers, unreachable content, changed bindings and corrupt bytes. Destination client tests verify generated HTTPS calls with fresh machine signatures and full 128 KiB responses; real source/destination Homes stage a canonical package without publishing its Session or remotely replacing corrupt cached bytes.

The ordinary member/hosted entrypoint does not yet install the complete handoff controller and therefore does not advertise handoff capability. Production physical writer and installed-generation exclusivity, source resource release, controller integration of target staging, Workspace move, paused adoption wiring and independent Continue remain separate work. This transport and object owner do not establish those proofs. Source object caches remain conservatively retained; terminal reclamation must use native epoch and object ownership rather than deleting potentially live bytes. See [Session portability](../../../architecture/session-transfer.md).
