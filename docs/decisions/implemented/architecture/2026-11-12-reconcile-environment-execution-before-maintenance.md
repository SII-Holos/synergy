# Decision Record: Reconcile Environment execution before maintenance

Status: implemented

## Problem

Holding Session execution does not establish that an earlier Environment request, remote process or output save finished. Blocking every resource-use acquisition would also prevent an accepted operation from completing its native Workspace save. A command retry must observe its original receipt without starting another effect.

## Decision

Base Harness registers the Environment owner with the sole purpose-bound Runtime maintenance operation. New native allocations and execution intents check admission before external dispatch and again in their publishing transaction. Exact existing execution requests retain observation and reconciliation. Existing native resource uses and final saves retain their owning paths.

Maintenance inspects actual in-flight allocation/provider and execution/finalization owners. An active request remains a reconciliation requirement until its owner settles. Bounded active-key walks load canonical allocation and execution records; malformed indexes or unknown schemas fail preparation. Ready or idle allocation metadata does not stand in for execution completion.

The native execution owner reconciles existing operations without resubmission. Confirmed process-tree and stream completion permits the established checkpoint, output capture, executor release and retained-use release. Unknown or running execution, missing stream drainage, incomplete saving and uncertain release block freeze. Final inspection requires completed native execution records. Repeated reasons are grouped by fixed requirement code rather than retained once per historical operation.

## Alternatives considered

**Refuse every resource-use acquisition during drainage.** Native detachment and final saves acquire their own scoped uses; a blanket refusal would strand accepted work.

**Treat process exit or a disconnected socket as completion.** Descendants, streams and Workspace publication can remain unfinished. The existing native execution protocol owns those facts.

**Start an uncertain operation again.** Its stable native operation already owns the accepted external intent. Reconciliation cannot issue another start or allocation.

## Consequences

The owner supplies maintenance integration for recorded Environment requests and executions. It does not independently certify all unregistered native processes, Workspace writers, remote provider implementations or a former Runtime cohort. Those actual owners and the hosted writer fence remain necessary for a complete deployment backup or restore. Active provider requests report a recoverable requirement; the operator retries drainage after their native completion rather than treating them as stopped. Native completed records retain terminal checkpoint failures; their resource settlement cannot turn a failed capture into a successful backup report.

## Verification

Real Runtime/SQLite fixtures use a contract Executor to observe dispatch and release counts. They retain exact command observation while denying a new execution and allocation, reject incomplete process/stream drainage, finish the original checkpoint and release once, and hold an actual pending provider promise until its original allocation completes. Existing execution tests cover lost responses, restart, retained use and saving failures. These protocol fixtures are separate from final native-process and deployment acceptance.
