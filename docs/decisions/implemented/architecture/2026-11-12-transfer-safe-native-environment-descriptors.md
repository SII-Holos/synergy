# Decision Record: Transfer safe Native Environment descriptors

Status: implemented

## Problem

A selected Environment is an execution destination owned by its current provider and native catalog. Copying its spec, allocation or mount receipts would carry private host authority to a different machine. Dropping the selection would erase retained resource identity. Session transfer therefore rejects selected Environments until an owning reader can preserve supported facts and prove a real destination mapping.

## Decision

The explicit `SessionTransferEnvironments` contribution introduces version-one descriptor portability for Sessions with no Environment Execution history. [Reader 2](2026-11-12-transfer-completed-environment-history-through-native-owners.md) extends this implementation with completed operation and output facts while retaining the original descriptor safeguards. The existing provider registry gains an optional pure descriptor callback. The Local Native provider validates its strict empty spec and returns platform, architecture and declared capabilities without allocating compute. Version-one root discovery rejects unsupported providers, specs and all execution history before native pause; recoverable tool drainage remains separate. The owner rechecks canonical selection during freeze and export.

Source freeze waits for original Session preparation and canonical Use drainage, then seals immutable safe facts against the exact handoff and member. Seals contain only original Environment identity, provider, generation/state observations and the validated descriptor. Prior mapping receipts stream independently in bounded pages, including after restart. Neither growing Session arrays nor a second executable Environment catalog is introduced.

The receiver declares a Core read dependency and uses its public `stagedInfo` callback reader, which shares Core's sole metadata/address parser. A caller's projected null Environment cannot hide the actual imported selection. An explicit destination mapping must name an existing same-Scope Environment with a compatible descriptor from its own registered provider. Missing, null, incompatible and foreign-Scope mappings reject.

Publication declares Environment-before-Core ordering. The original epoch activation transaction changes the native catalog binding through the Environment owner, publishes paused Core metadata and retains the immutable mapping receipt. A failed publication rolls back all three. Existing orphan bindings or conflicting receipts reject instead of being overwritten. Provider specs, credentials, allocation records, executor receipts and local mounts are not transferred.

The Environment owner centrally registers strict record and bounded physical migrations for source seals and receipts. Unknown versions, malformed addresses and extra fields reject without deleting retained facts. This adds non-executing evidence rather than changing the current Environment/Execution format; the portable manifest's required owner version fences readers missing this capability. It grants no execution or machine control.

## Alternatives considered

**Copy complete Environment records.** Specs and allocation details contain host-local authority and do not establish a valid target provider or native binding.

**Recognize the provider name alone.** A name cannot certify a spec's safety or prove compatibility. The original registered provider must validate and describe it.

**Map missing destinations to null or the local default.** That silently changes a retained execution selection and bypasses explicit mapping.

**Export safe metadata while ignoring execution history.** That would make an incomplete package appear lossless. Version one blocks completed history; the owning reader-two extension adds complete native records and output instead of silently weakening that gate.

## Consequences

Explicit hosts can transfer a supported unused Native selection without starting compute, while ordinary catalog and execution admission remain authoritative. Version-one packages remain descriptor-only. Reader two carries exact completed operation/output facts; active operation drainage, cloud resource mapping consent and default organization controller enablement remain separate.

Verification uses Local Runtime `test/session-transfer-environments-native.test.ts` for two actual Native Homes, explicit mappings, hidden-null Core evidence, activation rollback, paused targets, cold receipt re-export, strict specs and unchanged completed command/output refusal. Harness `test/environment/transfer-records.test.ts` exercises immutable collisions, central import validation and a bad physical-migration row beyond the first page. Existing `test/session/transfer-environments.test.ts` verifies complete Use drainage independently of this reader.
