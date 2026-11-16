# Decision Record: Forward interaction decisions through native admission

Status: implemented

## Problem

Calling a pending permission or question endpoint directly bypasses organization authorization ordering, signed binding evidence and lost-response reconciliation. A service receipt alone cannot atomically grant a native Runtime rule. A reply accepted under an inner Scope can also lose that context when an outer command transaction later publishes its notifications.

## Decision

Add a strict decision payload to the existing command family. Its digest binds the complete target, logical request, native pending identity, optional Cortex child source and exact reply. The service signs the same actor, deployment, connection, binding and sequence claims used by ordinary commands. Current collaboration roles authorize replies to existing confirmations even when a project is archived. Read-only roles cannot reply, and organization administration does not expose another creator's private Session.

The Runtime uses one canonical root/child resolver shared with private reads. It delegates to PermissionNext or Question inside the command receipt transaction. Always allow retains the native Runtime-wide rule owner; the service does not invent per-tool roles or merge collaborator resource grants. Receipt effects distinguish resolution, an existing winner and expiry. Their winner projection excludes question values and native Scope information.

Native after-commit settlement explicitly restores its captured Scope. A committed-but-unacknowledged command can be queried through the existing receipt path; the native owner settles its tentative original caller only after reading the matching durable decision. Reconciliation cannot create another answer, reopen a transferred source or replace the original private question values. The immutable native and command receipts remain the authorities; tentative settlement state grants nothing.

## Alternatives considered

**Use creator-only private Read permits for collaboration.** Reading a private body cannot authorize a shared execution action.

**Add an independent reply transport.** It duplicates ordering, authorization and unknown-result handling already owned by commands.

**Return submitted question values in service receipts.** Winner attribution and answer status do not require retaining those values.

## Consequences

Protocol tests cover complete target/value digests and rejected caller routing or actor fields. Native tests cover first-writer attribution, surrounding command rollback and receipt-only recovery after an actual committed transaction loses its acknowledgement. Service tests cover archived collaboration, read-only denial, private administrator exclusion, signed forwarding, immutable retries and generated API metadata. A real HTTPS/WSS member test settles both the native permission and private Question through generated clients and verifies value-free receipt queries.

Safe pending reads use the separate [native interaction query](2026-11-11-read-native-interactions-without-private-history-access.md). Its frontend decision UI remains a separate integration. This record does not declare the complete collaboration or original PRD acceptance finished.
