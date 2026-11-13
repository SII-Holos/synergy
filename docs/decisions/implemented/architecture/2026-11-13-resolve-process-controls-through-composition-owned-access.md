# Decision Record: Resolve process controls through composition-owned access

Status: implemented

## Problem

The personal Process tool enumerates one Runtime's background processes. A multi-account composition cannot infer access from that shared Registry or a guessed process identifier. Process ownership must remain tied to original native recording, while the domain independently authorizes the current caller.

## Decision

Harness exposes `ProcessAccessSource` as a Runtime-scoped composition port. Registered callers require the current native Session Rollout and detached call-time identities. The access callback retains the original primary Store and artifact ports, cancellation and callback lifetime. Its source rechecks current domain authority and decides whether original process metadata is visible. A composition without the source preserves personal behavior.

Native Rollout recording binds Process ownership to the original Registry object only after its Process record is written. Finishing carries that metadata to the original finished object. Returned metadata is a detached descriptor, not a permission capability; a domain source must verify its canonical producer and caller records.

Local Process operations use one finite access callback for enumeration, output and controls. Lists filter by original ownership; individual operations authorize before accessing their target. Controls recheck immediately before dispatch, and the callback rechecks before returning. A restricted control that has started but cannot confirm its result reports structured unknown outcome without automatic replay. Personal operation behavior remains unchanged. Restricted calls without file resources omit automatic local attachment discovery.

## Alternatives considered

**Hide only process listings.** A stale catalog or guessed identifier could still reach log, stdin or termination operations.

**Use different Runtime registries as authorization.** A shared Runtime can contain several independent tasks. The same native Runtime must also reject a foreign caller.

**Treat retained ownership metadata as permission.** Metadata supplies original identity; current object authority belongs to the composition's canonical owners.

## Consequences

Trusted hosts can supply process access without narrowing personal Runtime behavior. The generic source does not implement organization roles, Service authorization or retained remote execution controls. Its tests cover native call context, detached facts, cancellation and expired callbacks. A real local native fixture verifies same-Runtime foreign rejection and original-owner stdin, output and successful completion. Organization integration requires its separate accepted-root and current-actor evidence.
