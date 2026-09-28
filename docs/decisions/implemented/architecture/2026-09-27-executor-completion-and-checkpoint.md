# Decision Record: Separate execution completion from durable saving

Status: implemented

## Problem

A command can finish while output or modified files remain inside disposable compute. A lost response can also hide a successful external effect. Reporting success or reclaiming resources at either point can lose data or repeat the effect.

## Decision

Harness persists operation identities, input digests and allocation targets before sending commands. Its execution service reconciles existing operations without reissuing commands. Executor completion carries native tree and stream drainage evidence. Only physically completed operations can enter checkpoint publication. Output is flushed into the existing Agent Storage artifact pack before checkpoint completion. Failed saving retains the Environment use; the retry path repeats saving only.

The native Executor uses the existing `OwnedProcess` implementation and physical Workspace coordinator. It writes a private operation receipt and bounded output spool that can be queried after a lost response or executor restart. This spool contains execution receipts rather than Agent state. Native and transported Executors use the same request, status and output schemas. Environment providers remain independent of Synergy Link.

Bash uses the common process facade with the resolver's admitted target. Target-side sandbox preparation keeps containment on the same OS and filesystem as execution. Its foreground closure waits for saving, while background execution owns a durable use independently of the caller's admission. Failures confirmed before command activation close as failed executions without fabricating uncertainty about effects.

Durable process claims persist until explicit release, including after their finalizer exits. Recovery requires the original claim reference. Host-local ledger version 2 prevents older coordinators from silently discarding this retention requirement. Its upgrade occurs under the existing host-wide coordination lock when a durable claim is first written; it does not migrate Agent records or create a second coordination file.

## Alternatives considered

**Retry uncertain commands.** The remote or native process may already have performed an irreversible effect. A stable operation identity plus inspection preserves uncertainty without repeating effects.

**Release when the root process exits.** Descendants, pending output and checkpoint publication can outlive that process. The existing native ownership proof and an explicit save acknowledgement determine release.

**Expire a writer lease after a timeout.** A network partition or stopped controller does not prove that the writer stopped or that its files were saved. Durable claims require confirmed reconciliation instead.

## Consequences

Foreground completion can distinguish execution from saving. Unknown operations deliberately retain resources until their owner can establish completion. The receipt spool is operational metadata with its own physical-resource lifetime; authoritative execution history and output remain in Agent Storage. Checkpoint implementations must publish a consistent view and provide their committed version before acknowledging success.
