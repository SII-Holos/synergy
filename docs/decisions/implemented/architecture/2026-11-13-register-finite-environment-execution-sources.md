# Decision Record: Register finite Environment execution sources

Status: implemented

## Problem

An external execution owner needs to retain its actual allocation, cleanup and observation without fabricating a local Environment. Persisted target metadata cannot authorize dispatch. Preparation can outlive the initiating observer, and a lost cleanup acknowledgement must retain its original owner instead of appearing drained.

## Decision

Harness provides a composition-registered Environment execution source with private live leases. The registration and lease retain the composing Runtime, actual primary Store and options, artifact ports and original native origin. The finite executor exposes preparation through tracked callbacks; process submission and control use the canonical Environment execution owner. Remote I/O rejects actual Storage transactions and snapshots, while metadata checks remain usable inside their original publishing transaction. An actual readonly primary may inspect retained observations but cannot enter a new source producer.

Release closes lease admission, drains accepted callbacks and invokes the original cleanup closure. Unknown cleanup and failed source closure retain that same owner for retry. A callback cannot close its own registration or release its own active lease. Hosts drain the registered source before releasing its storage and transport.

Cold cleanup reads canonical active records through paged owning readers and can retire only their original source, target, digest and origin under the actual primary. Independent signed discovery derives minimal selectors from retained grants, native operations and Uses; it returns no private directory or dispatch authority. An old admission retires only against its exact canonical old-epoch Use in the writable primary. Absent evidence is not a release receipt. Recovery follows bridge attachment and respects the existing unconfirmed-dispatch horizon instead of inspecting an intent that may still commit. Original physical completion and saved output remain mandatory.

An accepted command retains a separate `OriginalOperation` under the same live lease and actual committed controller record. It preserves the exact source, target, origin and normalized command digest after public admission ends. This capability cannot allocate, prepare or start another command. Closing it requires the actual completed controller row; the registration remains retained until that native operation has settled. Closing seals new calls immediately. An already accepted callback retains its original operation occupancy until its own tracked finalizer exits. If native completion closes admission before that callback returns, its postflight check still requires the composing Runtime, primary Store, registered source, native origin and exact canonical completed tuple. A closed flag alone never approves a return, and unknown completion keeps the original owner pending. Closure does not wait on that callback from inside the completion path, avoiding a cycle between native saving and its accepted cancellation acknowledgement.

The organization adapter rechecks the current accepted actor through the existing Session, project and API-token owners. Process controls retain that call-time authority through connection and recheck immediately before the native effect. Independent machine-signed retirement and inspection act only on the original admission or execution and return no output or new admission. Unknown acknowledgements retain the original owner; inspection establishes whether that exact work completed before a retry.

Service completion owns the native operation and its preparation cleanup in one promise. Cancellation can overlap automatic completion, so a resumed caller revalidates the actual completed record and existing cleanup state before returning. It does not reopen a closed Service tail. Admission inspection requires both removal of its actual Use and completion of the original release closure.

Source-backed execution uses a strict version-three persisted envelope. Native version-two receipts retain their existing representation. The source record and complete original observation are metadata, never a live capability; completed history retains locally stored output. The owning central migrations validate canonical addresses and supported receipts without converting history into authority.

Registered Host origins can supply private current-admission and mutation checks. Native allocation rechecks after allocation-intent publication and before the provider effect; command dispatch rechecks after connection. Resource resolution supplies a frozen release-only facet immediately after actual acquisition, before later description or attachment awaits. Failed resolution and failed cleanup preserve both original errors.

The native recovery owner has an explicit inspection-only allocation mode. It inspects the original request, preserves a pending allocation and old admission Uses, and does not resume that partial request. Ordinary recovery retains its existing same-request resume behavior. Original releasing operations retain their existing release owner. Bounded canonical metadata readers support owner inventory without creating resources.

## Alternatives considered

**Mirror an external allocation as a local Environment.** This would create a second allocation catalog and confuse native Session selection with the external physical owner.

**Authorize from a serialized source record.** Retained data cannot establish current resource permission or a live process-control lease.

**Clear pending callbacks on close or forget failed cleanup.** Neither establishes physical completion; both can release storage while an original producer remains active.

**Use ordinary allocation recovery for inspection.** A verified partial request can legitimately resume under ordinary recovery, which gives an inspection-only composition additional effects.

## Consequences

The source, receipt, Host and cleanup owners are tested with actual native Uses, processes, input preparation and cold allocation receipts. Organization acceptance covers selected remote Workspace execution and saved bytes, same-Runtime foreign-root rejection, current actor and token revocation, and original cleanup after lost acknowledgements. A live registration's retry does not reconstruct a closed Runtime registry or establish Environment-free observation, complete file CAS, Handoff mappings or external deployment acceptance. Those remain separate owning scenarios. See [Environments](../../../architecture/environments.md).
