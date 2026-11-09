# Decision Record: Release organization execution resources by generation

Status: implemented

## Problem

A native root can finish using its resources and later continue under the same identity and budget. Permanently closing its execution grant prevents that continuation; clearing a Session counter alone lets a previously prepared capability become usable again when resources are reacquired. A delayed release request can also arrive after a subsequent execution starts.

## Decision

Keep the bound grant and root index independently of resource occupancy. Each retained use has a generation. Binding a provisional grant establishes generation one; rebinding a released grant increments it while retaining native identity, original binding time and cumulative call evidence. Both transitions share the directory transaction.

Release uses a finite, domain-separated machine proof containing accepted intake, root identity, generation and terminal outcome. The service verifies the current machine and Session binding, reconciles acceptance, and independently checks its gateway's active requests before writes and before commit. A released generation gets an immutable receipt in the same transaction as its occupancy decrement. Repeated release returns that receipt without touching a newer generation. Disabled resources, revoked project access and handoff cannot prevent the existing driver from releasing drained work. Generation-zero cancellation closes provisional accepted intake without a fabricated native root.

Gateway call records capture the retention generation at reservation. Invocation and the pre-transmission transaction compare it with current retained authority. Old capabilities remain unusable after reacquisition; their historical receipts remain readable. Central record-access migrations assign existing grants and calls generation one without rewriting signed capabilities or scanning historical Sessions at startup.

Retention inspection is separate from executable resource description. A bind can commit while its reply is lost; subsequent resource disablement or project revocation must not prevent the current driver from learning which generation needs cleanup. The accepted-task metadata proof authorizes this read without granting new use. Local archive and transfer fences preserve this proof, while the service still checks the machine, connection and canonical Session binding. Inspection neither reacquires resources nor changes their generation.

## Alternatives considered

**Close or replace the root grant on completion.** This disconnects continuation from its accepted intake and existing evidence, and risks resetting execution budgets. Occupancy is independent of root identity.

**Use only the directory counter or connection epoch.** A counter cannot identify which retained use a delayed release owns. A connection can also remain valid across several uses of one root. Per-generation receipts and dispatch checks cover both races.

**Trust terminal state or a bounded activity query as drainage.** Neither proves that prepared work, native owners and streaming transports have exited. The service checks its own physical requests. Automatic native release requires a separate owner integration that fences preparation and proves drainage before signing.

## Consequences

The generated API and verified member client expose release with response identity, outcome and generation checks. They do not automatically infer native completion or replay missing work. Native release production, child execution and business-resource drainage remain separate integrations.

Tests cover real upstream streams, a gateway request admitted during release publication, expiry/disconnect and write rollback, stale capabilities after reacquisition, provisional cancellation, changed selection, disabled resources, handoff, revoked project access, storage restart, renewed connection proofs and lost HTTPS replies. Legacy records retain signed authority and raw stored evidence through upgrade.

Additional HTTP and native-intake tests cover lost bind replies followed by resource disablement, inspection of released authority through handoff and role revocation, stale bindings, altered responses, local archive/transfer and connection cancellation. These reads do not establish physical drainage or produce a release proof.
