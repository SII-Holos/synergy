# Decision Record: Restrict shared projection writes to current Runtimes

Status: implemented

## Problem

Shared event batches describe native Runtime observations. A creator's browser credentials established sharing authority but also accepted projection batches through a separate HTTP writer, independently of the current registered driver. Binding and payload checks validated the submitted metadata without establishing its producer.

## Decision

Projection batches enter through the existing authenticated Runtime connection and `OrganizationSharing.applyBatchFromRuntime`. The machine connection verifies its signature, current connection epoch and declared synchronization capability. The sharing owner then checks active machine/account authority, the current Session driver, binding, generation, payload digest and contiguous sequence inside its original transaction. The browser batch route and credential-based domain writer are removed from the generated HTTP API.

Creator compare-and-set share/revoke controls and authorized projection reads keep their existing owners. Creator uploads of immutable, hash-verified blob bytes remain supported under the [blob integrity decision](../architecture/2026-11-11-page-shared-blob-receipts-and-publish-verified-integrity.md). Possession of such bytes does not commit an event, reference or checkpoint.

Existing projection, transcript, task, presentation and retention tests obtain their producer through a real signed WebSocket handshake with the registered machine's actual key. They send the existing batch frame through the production connection receiver; no account credential or fabricated handshake substitutes for that producer.

## Alternatives considered

**Keep the creator HTTP writer with stricter metadata comparisons.** A current creator can still supply matching metadata without being the native observation producer; extra comparisons do not establish machine authority.

**Add machine proofs to another HTTP batch endpoint.** The authenticated connection already owns current machine identity, epochs, capabilities and exporter acknowledgements. Another route would duplicate that admission path without a product consumer.

**Remove browser blob uploads as well.** Immutable content upload has an explicit creator authorization policy and cannot advance the projection checkpoint. Retiring it would change a separate accepted feature without addressing the producer defect.

## Consequences

Human clients cannot replace the native shared projection or advance its checkpoint. Existing registered Runtime exporters retain their wire frames, idempotency receipts and generation fences; stored projections need no migration. HTTP clients generated against the removed writer must use the Runtime exporter. Regression coverage separately verifies rejected human writes, unchanged state and a successful genuine Runtime write. See [PM-0177](../../../postmortem/0177-shared-projection-accepted-human-writer-authority.md).
