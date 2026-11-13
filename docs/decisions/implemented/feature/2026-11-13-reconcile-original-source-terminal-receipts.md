# Decision Record: Reconcile original Source terminal receipts through enrolled HTTPS

Status: implemented

## Problem

A Source can commit cancellation or permanent surrender before its WebSocket reply reaches the service. After revocation or shutdown, ordinary connected controllers cannot report that retained fact. Repeating a native operation or trusting a frozen snapshot would manufacture a different recovery action.

## Decision

The existing machine recovery route issues a separately signed, finite Source-receipt inspection permit to the exact original enrolled participant. Its request uses the retained Home key and verified service TLS. It does not reuse the Target cleanup permit. The original proof endpoint remains the only fact acknowledgement endpoint.

`SessionTransferSource.retainedReceipt` reads the original cancellation or surrender keys through their existing codecs and rechecks the original Epoch record. Missing terminal evidence is absence of a fact; frozen data alone cannot establish cancellation or surrender. Conflicting terminal rows and relocated selectors fail closed.

The Runtime uses one shared Source receipt reader for ordinary inspection and restricted recovery. It binds the actual registered Runtime primary, Store options and artifact owner through deferred reads, signing and acknowledgement. Canonical Core metadata is read without hydration or migration and must agree with its Session index. The original Command State and native organization metadata establish stable organization, project Scope and root identity. Current driver and epoch are not compared with an old receipt. Surrender also retains its exact original signed permit, manifest and prepared hash.

The existing restricted cleanup lifecycle exposes `org-runtime cleanup source-receipt`. It takes the original private enrollment input and handoff ID, acquires the original Home process lock and attaches existing storage read-only. It starts no ordinary connection, Agent, plugin or task recovery, and creates no native gate or ledger. It can report only an already durable terminal fact.

Once the proof POST begins, transport failures, unverifiable replies and failed post-send owner or cancellation checks preserve `unknown`. A genuine structured service rejection keeps its original semantics. A subsequent cold invocation re-reports the same original fact hash without repeating native effects.

## Alternatives considered

**Reopen an ordinary Runtime.** Rejected because its connected startup can restore unrelated services and work, and does not fit revoked-machine cleanup.

**Borrow Target cleanup authority or repeat cancellation/surrender.** Rejected because existing Source evidence and a new native transition are different operations with different participants.

**Trust the call-time Store or current Session binding.** Rejected because a foreign namespace can contain a matching terminal tuple, and a Session can legitimately return to the same Home under a newer epoch.

## Consequences

Member-machine recovery can reconcile original cancellation and surrender after lost replies, revocation and cold reopening while retaining all private bytes. This unit performs no new freeze, cancellation, surrender, retargeting, execution or Continue. Hosted has a typed service branch but lacks an end-to-end Source recovery fixture here; it remains a separate required follow-up. Again-surrender and complete DATA20 recovery remain outside this unit.

## Verification

The new Kernel receipts and Core metadata tests cover canonical terminal selectors, conflicting facts, cold reads, index/Scope/root mismatch, unknown metadata retention and no hydration or writes. The Member two-Home HTTPS fixture covers retained cancellation before/after freeze, surrender, missing terminal facts, genuine foreign namespaces and wrong native Scope. Actual committed proof replies are intercepted as structured unknown, empty data, wrong fact hash and post-commit observer cancellation; cold retry must acknowledge the original fact hash. The unchanged old Source HTTP cancel/transfer/unknown scenarios and revoked Target cold cleanup CLI also pass. The final non-overlapping total is 21 tests and 281 assertions; Harness, OrganizationProtocol, Organization and OrganizationRuntime typechecks, owned lint/format and diff checks all exit zero. The Kernel fixture activates the returning e3 binding through the actual Epoch owner before reading the unchanged original e1 surrender receipt.
