# Decision Record: Separate installed plugin preparation from activation

Status: implemented

## Problem

An installed plugin process verifies its parent's complete installation generation before loading host modules and registering its IPC receiver. Charging that work to the plugin activation timeout makes a valid cold installation compete with the plugin's own import and activation. Large sealed generations under concurrent filesystem load can exhaust the default five seconds without executing plugin code. Source-only runner tests do not exercise this preparation.

## Decision

Installed launchers advertise a versioned bootstrap control channel through their worker environment. Plugin Host explicitly requests that channel for each supported installed child. The launcher sends a one-time control record at its existing receiver-registration handoff, after verification and host initialization, identifying the runner and the complete verified generation pin. It derives the pin from the verified generation rather than echoing unverified environment input. The control record remains separate from Plugin API 4 and IPC 9.

Preparation has a host-owned absolute 300-second deadline from spawn. This uses the same allowance scale as Desktop's installation preparation, but does not renew on progress. After accepting the handoff, the host starts the existing plugin startup deadline before sending `activate`. Plugin import and activation remain subject to `startupTimeoutMs`, whose default is five seconds. Source and older launchers without the advertised channel retain the ordinary spawn-to-ready path; a child selected for the new path cannot silently downgrade when its handoff is missing.

The host accepts the matching handoff once. Wrong identity, runner or protocol, malformed records, premature plugin readiness, and child exit before handoff fail startup. Repeated valid records do not send activation again or extend a deadline. External-process startup termination releases timers, monitors and the owned process; stale callbacks cannot revive or remove another generation. Shared starts remain deduplicated, and a single invocation's cancellation does not cancel another caller's shared startup.

Failed or stopping startup rejects reentry from terminal Agent-call delivery while retaining its cleanup ownership. It must not await its own pending startup indirectly through that delivery. Process-start cancellation does not introduce a cancellation or join contract for trusted `inProcess` activation, whose plugin API supplies no cancellation signal.

The existing [component receiver handoff](2026-10-07-replay-component-runner-bootstrap-ipc.md) still owns early IPC replay and RuntimeContext lifetime. The [verified installation generation](../architecture/2026-09-25-installation-generations.md) remains mandatory for every installed child. There is no parent-verification cache or inventory shortcut.

## Alternatives considered

**Increase the plugin startup timeout.** This combines unrelated work and gives slow plugin activation a larger allowance without identifying whether installation preparation has finished.

**Skip or cache generation verification.** A parent's earlier verification cannot establish the bytes that a later child imports. This would weaken installation integrity to address a lifecycle accounting problem.

**Parallelize inventory hashing.** Reduced scan time cannot establish a correct activation start point, and contention can still consume the combined allowance. Inventory optimization is independent work, not a substitute for phase separation.

**Send the handoff immediately after pin verification.** Host initialization and runner import still precede listener registration. The existing registration callback identifies when the parent can safely begin plugin activation without inventing a second dispatch mechanism.

## Consequences

A stalled installed child can occupy preparation time longer than the plugin activation allowance, but the wait is absolute, independently bounded, and terminated by its owner. Only explicitly supported launchers use it. The implementation adds an internal launcher control exchange, not a plugin capability, configuration option or protocol revision.

Regression coverage must distinguish delayed preparation from delayed plugin execution, preserve tamper rejection before entry side effects, and exercise duplicate or invalid records, premature exit, owner-stop, cancellation-delivery reentry and child cleanup. A pending trusted activation must retain its existing owner-stop behavior rather than inheriting process cancellation. The real released-binary upgrade, restart and retained-plugin invocation remains the integration acceptance; a synthetic runner or successful source test alone cannot establish that result. Current behavior is documented in [Plugin runtime and capabilities](../../../plugins/runtime-and-permissions.md).
