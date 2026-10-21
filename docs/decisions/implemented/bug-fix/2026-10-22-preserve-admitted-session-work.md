# Decision Record: Preserve admitted work during Session recovery

Status: implemented

## Problem

Session detail reads reconcile persisted unfinished work. A newly accepted input is enrolled in recovery before its execution lease exists. Checking only the active lease allowed a concurrent detail read to latch an interruption while drive discovery or host admission was still pending, preventing the first model response without a user pause.

## Decision

Recovery checks the existing per-Session drive arbitration, wake chain and execution ownership. Drive arbitration remains registered until its scheduled wake takes ownership or its awaited wake finishes. Recovery rechecks ownership after asynchronous evidence reads and before latching a pause. It leaves the recovery receipt intact when live work owns the Session. No persisted schema, polling, client request or secondary scheduler is introduced.

## Alternatives considered

Disabling detail-read recovery would leave historical interruptions undiscovered. Treating any pending task anywhere in the Runtime as ownership would prevent unrelated Sessions from recovering. A new persisted admission flag would duplicate existing runtime ownership and require another restart protocol.

## Consequences

Accepted tasks remain runnable through their pre-execution interval. Restarted orphaned work still pauses and waits for explicit user action. Behavioral tests gate drive discovery and host admission using real temporary storage, verify both awaited and scheduled wakes, cross late lease acquisition with recovery reads, and retain unrelated-owner recovery and receipt cleanup checks.
