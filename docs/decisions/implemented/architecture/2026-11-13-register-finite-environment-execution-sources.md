# Decision Record: Register finite Environment execution sources

Status: implemented

## Problem

An external execution owner needs to retain its actual allocation, cleanup and observation without fabricating a local Environment. Persisted target metadata cannot authorize dispatch. Preparation can outlive the initiating observer, and a lost cleanup acknowledgement must retain its original owner instead of appearing drained.

## Decision

Harness provides a composition-registered Environment execution source with private live leases. The registration and lease retain the composing Runtime, actual primary Store and options, artifact ports and original native origin. The finite executor exposes preparation through tracked callbacks; process submission and control use the canonical Environment execution owner. Remote I/O rejects actual Storage transactions and snapshots, while metadata checks remain usable inside their original publishing transaction. An actual readonly primary may inspect retained observations but cannot enter a new source producer.

Release closes lease admission, drains accepted callbacks and invokes the original cleanup closure. Unknown cleanup and failed source closure retain that same owner for retry. A callback cannot close its own registration or release its own active lease. Hosts drain the registered source before releasing its storage and transport.

Source-backed execution uses a strict version-three persisted envelope. Native version-two receipts retain their existing representation. The source record and complete original observation are metadata, never a live capability; completed history retains locally stored output. The owning central migrations validate canonical addresses and supported receipts without converting history into authority.

Registered Host origins can supply private current-admission and mutation checks. Native allocation rechecks after allocation-intent publication and before the provider effect; command dispatch rechecks after connection. Resource resolution supplies a frozen release-only facet immediately after actual acquisition, before later description or attachment awaits. Failed resolution and failed cleanup preserve both original errors.

The native recovery owner has an explicit inspection-only allocation mode. It inspects the original request, preserves a pending allocation and old admission Uses, and does not resume that partial request. Ordinary recovery retains its existing same-request resume behavior. Original releasing operations retain their existing release owner. Bounded canonical metadata readers support owner inventory without creating resources.

## Alternatives considered

**Mirror an external allocation as a local Environment.** This would create a second allocation catalog and confuse native Session selection with the external physical owner.

**Authorize from a serialized source record.** Retained data cannot establish current resource permission or a live process-control lease.

**Clear pending callbacks on close or forget failed cleanup.** Neither establishes physical completion; both can release storage while an original producer remains active.

**Use ordinary allocation recovery for inspection.** A verified partial request can legitimately resume under ordinary recovery, which gives an inspection-only composition additional effects.

## Consequences

The lower source, receipt, Host and cleanup owners can be tested with actual native Uses, processes, input preparation and cold allocation receipts. Organization transport composition, native-only capability selection, live file access, background control ownership, cold preparation cleanup, handoff mapping and older-Service reader fences require their corresponding owners before full remote execution is available. These primitives alone do not establish that integration or Docker/PostgreSQL acceptance. See [Environments](../../../architecture/environments.md).
