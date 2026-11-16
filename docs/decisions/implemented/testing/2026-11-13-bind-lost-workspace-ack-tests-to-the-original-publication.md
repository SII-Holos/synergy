# Decision Record: Bind lost Workspace acknowledgement tests to the original publication

Status: implemented

## Problem

The cross-Realm lost-publication fixture treated any unknown HTTP result as proof that the cloud CAS had committed. The service's finite observer can end while the accepted native producer is still running. An early observation could therefore compare the old head against an expected published revision without reaching the intended acknowledgement-loss injection.

## Decision

The fixture holds the actual publish request before dispatching its service CAS, cancels only the original HTTP observer through its real Request signal, and records that the head is still unchanged. It attaches the first request's ordinary settlement handler before triggering cancellation.

The publication producer is the original service fetch returning success with its complete WorkspaceMove receipt. The fixture resolves that gate before replacing the successful response with the injected lost acknowledgement. It then waits for the same source machine's original completion reply before inspecting the original move again. The receipt exported to the destination must equal the receipt observed at the commit gate, and the publish dispatch count must remain one.

Readiness races actual producer completion and early errors. Bounded rescue retains the original observer and native failure causes; it cannot convert a timeout into a completed publication. Production deadlines and retry semantics remain unchanged.

## Alternatives considered

**Raise the HTTP or native deadline.** This would hide the invalid implication from unknown observation to committed effect.

**Poll the cloud head or retry publication until it appears.** Either could erase the transient failure or obscure replay. The original producer supplies the required evidence.

## Consequences

A controlled native publish barrier reproduces the original revision mismatch without sleeping or waiting for a timeout. The repaired scenario verifies early observer closure, actual CAS completion, lost acknowledgement, accepted-job drainage and same-receipt reconciliation independently. Other file-transfer scenarios retain their existing behavior.
