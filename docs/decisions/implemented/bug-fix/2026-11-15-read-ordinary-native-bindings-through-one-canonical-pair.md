# Decision Record: Read ordinary native bindings through one canonical pair

Status: implemented

## Problem

Native synchronization validates a known Session/Scope binding while capturing every committed native fact and repeatedly while converting and publishing each retained delivery. Ordinary binding first reads the Session index, then Core reads the same index together with Info in the existing snapshot. This performs two data SELECTs and three logical record lookups per binding check. Creation-time `mutationBinding()` already uses one canonical pair read and is not the target of this change.

## Decision

Add `Core.storedInfoIfPresent()` to the same canonical reader used by required `storedInfo()` and creation-time `storedInfoIfComplete()`. The three modes share selector validation, one fresh index/Info batch, persisted metadata decoding and exact Session/Scope/parent ownership checks. Required mode rejects either missing record; complete mode retains its original partial-creation behavior; present mode returns undefined only when both records are absent and rejects either partial pair. Existing required and complete modes retain their original schema/error ordering.

Ordinary native binding with a supplied Scope uses present mode. Creation mutation probes continue to use complete mode. The unknown-Scope lookup path is unchanged. Every binding invocation fetches current records through its original snapshot, including same-transaction writes and rollback. Ancestor traversal, current driver/epoch comparisons and all per-mutation/delivery authority checks retain their original owners; no result or absence is cached. Native binding retains `Session.Info.parse()` because its Runtime-selected extension validation and projection are distinct from Core's `Session.PersistedInfo` decoder.

The new ordinary known-Scope path explicitly aligns errors with the canonical reader. A foreign Scope index raises the original Core `SessionTransferOwnerRejected` with its structured Scope message instead of the adapter's plain Error. An empty selector rejects through the canonical Zod validation rather than returning absence. A physically damaged additional Info body may fail earlier with the unchanged `StorageIntegrityError` during the pair fetch. No error is caught, repaired or replaced by a compatibility fallback. The command transport still maps these non-`OrganizationRuntimeError` failures to its existing `SERVICE_UNAVAILABLE`, unknown outcome and nonretryable result; they never grant authority.

## Validation

The existing native-binding fixture measures actual native data SELECTs through its original transaction while invoking the existing ordinary binding API. It requires the same valid Bound and one data statement instead of two. Canonical reader controls cover wholly absent, each partial pair, foreign Scope, malformed index, wrong Session/parent and rollback. Native binding controls preserve live driver/epoch changes, Runtime separation and dynamic organization-schema rejection. Existing creation-pair, native capture, projection, delivery and invalid-selector Promise tests remain intact.

## Alternatives considered

**Retain the adapter pre-read.** It repeats a canonical index lookup on every known-Scope capture and delivery check, despite the Scope already being available to the Core owner.

**Use the creation reader for ordinary reads.** Creation probes intentionally tolerate either missing half of a pair. Ordinary binding must reject such partial ownership and permit absence only for a wholly missing pair.

**Cache parsed bindings or add a compatibility fallback.** Reusing authority or catching canonical failures would obscure current changes and malformed ownership. The existing snapshot supplies one fresh pair without an alternate reader.

## Consequences

Each ordinary known-Scope check reads the same two canonical rows once, reducing two data SELECTs to one without reducing the number of validation checks. Unknown-Scope lookup and the already-batched creation mutation path retain their costs. Persisted representations, transport APIs, workload, queue windows, and the original 240s/600s capacity budgets do not change. This native work bound is not proof of the full capacity deadline or a host-independent performance improvement.
