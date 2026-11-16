# Decision Record: Persisted Home ownership outside optional execution

Status: implemented

## Problem

An optional organization component can be removed while its Home still contains domain-owned records. Selecting fewer components must not turn that Home into a personal Runtime or admit work under another account's identity. A storage-only check is too late for global initialization and cannot protect independent services that use a different database file.

## Decision

Harness validates a small versioned ownership marker at the Runtime root before initialization writes or execution storage startup. The selected owner and stable identity digest must match. Unsupported or malformed metadata remains a blocking condition; missing optional owners cannot silently assume personal ownership. Explicit provisioning publishes the marker atomically under a file lock. Runtime startup requires an already persisted identity and validates it again after migrations.

Legacy personal Homes without a marker retain their existing behavior. The independent organization service adopts its marker through an owning versioned migration in its non-executing lifecycle, preserving existing deployment identity and rejecting initial adoption of personal Runtime data.

## Alternatives considered

**Infer ownership from selected components or configuration.** Removing or disabling a component would erase the evidence used to decide ownership, permitting personal startup over organization data.

**Keep the marker only inside the domain database.** Ordinary global initialization precedes opening execution storage, and independent services can use a different database file or namespace. Root metadata lets generic admission reject the wrong owner before those paths diverge.

**Assign ownership automatically during ordinary Runtime startup.** An incorrectly selected Home could then acquire organization attribution. Provisioning and explicit non-executing owner migrations establish identity before execution admission.

## Consequences

Ownership survives component selection changes and backup copies without moving personal history or exposing account identifiers in the generic marker. Provisioning must preserve the marker, and damaged metadata requires explicit repair instead of fallback. This guards Home admission; it does not replace per-Session ownership, transfer gates, machine authentication or database writer fencing.
