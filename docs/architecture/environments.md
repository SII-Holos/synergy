# Environments

An Environment identifies an execution destination independently of a Session, Scope and Workspace. Harness owns the catalog in Agent Storage; native and remote resource owners implement providers. Synergy Link does not supply Environment transport or identity.

## Identity and lifetime

Owner bindings select a logical Environment without allocating it. `Environment.acquire` persists an allocation intent before calling its provider and coalesces concurrent acquisition within the writing Runtime. The target includes the Environment ID, physical allocation ID and monotonically increasing execution generation. Workspace binding generation and content version are separate values.

A provider reports an allocation as ready, absent or unknown. Unknown allocation results are inspected by their original request identity. They are never retried as new allocations without confirmed absence. Recovery reconciles an active-allocation index before admitting work. Missing providers fail explicitly.

Every acquired use is persisted and blocks deallocation until released. Uses survive a Runtime restart; restarting the Runtime is not proof that remote work stopped. Provider deallocation must confirm physical termination before the catalog returns to idle. Reclamation applies to managed resources after the configured idle interval; borrowed native resources preserve host ownership.

## Ownership

Environment providers are registered during Runtime composition and sealed before storage startup. Registration is isolated across Runtime instances. Structured records, owner bindings, uses and active indexes share [Agent Storage](agent-storage.md) transactions. External allocation, inspection and termination run outside retryable transactions.

The [decision record](../decisions/implemented/architecture/2026-09-27-environment-allocation-identity.md) explains independent identity and reconciliation. Workspace authority remains defined by [Workspace and files](workspace-and-files.md).

## Execution and saving

`EnvironmentExecution` persists an operation identity, input digest and allocation target before dispatch. Repeated submissions inspect the existing operation. Different inputs for an occupied operation identity fail. A missing executor receipt produces an unknown result, not a repeated command. Cancellation is persisted before transmission and requires executor confirmation.

The versioned Executor protocol carries command, PTY, input, cancellation, status and cursor-based output operations. An exit becomes eligible for saving only after native tree and stream drainage are confirmed. Output is copied into Agent Storage artifacts before the caller's checkpoint is published. Saving failure retains the use and physical writer; retries invoke the checkpoint rather than execution. A saved result precedes executor release, and lost release acknowledgements can be retried independently.

Local Runtime registers the borrowed `native` provider. `localRuntime({ environment: false })` omits that provider. The native executor uses `OwnedProcess` and the existing Workspace coordinator. Its private receipt spool stores operation status and output, not Sessions or Agent configuration. Durable process claims survive the executor owner and require their recovery reference for release. The coordinator upgrades its host-local ledger to version 2 under its existing lock when the first durable claim is admitted; older readers reject this version rather than dropping retention metadata. The Agent Storage schema is unchanged.
