# Decision Record: Verify restored Homes before opening Runtime admission

Status: implemented

## Problem

A staged format-three Home could open a generic Runtime before its native publication had completed. The Runtime did not check the installation intent before Session staging and migrations. Native Node readers also need the completion codec without importing Runtime, Storage or Agent implementations.

Publication facts sometimes cross Runtime boundaries. An arbitrary callback or copied description cannot establish the original publication owner or keep its process and primary Store alive.

## Decision

Move the existing restoration frame codec, bounded native reader and physical identity checks into the Node-compatible `lifecycle/home-restoration-file` leaf. Lifecycle consumes that same implementation. Its completed preflight returns metadata only; it cannot authorize SQL, native publication or execution. Organization Runtime exposes the matching native selector as optional `RuntimeHome.restoration`; format-two results retain their existing JSON, and SQL/domain publication remains the Kernel owner’s check.

Register the Home restoration guard in the base composition. Once the actual primary Store is attached, check ordinary startup before Session staging or migrations. Completed native frames still require their registered domain's committed publication, current native readiness and original maintenance release.

A publication owner may provide bounded facts for one named subject. Only its actual publication permit can issue a callback-bound inspection. The inspection retains the original Runtime, primary configuration and process-lock lifetime; a foreign Runtime can read it through a pure guard. Description data alone never becomes evidence, and no two-Store atomicity is claimed.

Persistent dataset identity ignores read-only, recovery and must-exist opening modes while retaining the backend, namespace, connection configuration and physical database identity. Live callbacks still require their exact full options. Read-only Handles may validate ordinary readiness and published history; installation, completion, release and native configuration writes still require the original writable primary.

## Alternatives considered

**A separate Node parser** permits reader drift; the same owner supplies both readers.

**Validation after migrations** admits effects before proving readiness, so the check follows Store attachment directly.

**One options hash for every purpose** either rejects legitimate cold reopen modes or weakens callback ownership. Persistent dataset identity and exact live configuration remain separate.

## Consequences

Incomplete or foreign restored Homes fail before ordinary startup effects. This establishes no Hosted writer reconciliation, fresh grant or automatic Continue; those remain owning recovery operations.

## Verification

`packages/harness/test/lifecycle/home-restoration.test.ts` reproduces actual staged-Home Runtime readiness before the guard. `test/storage/runtime-maintenance-adoption.test.ts` verifies completed publication, cold and read-only reopening, cross-Runtime inspection and expired evidence while retaining actual native/SQL guards. Organization Runtime's Node reader tests consume the public leaf separately.
