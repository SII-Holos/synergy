# Decision Record: Preserve authenticated heartbeats through held Service writes

Status: implemented

## Problem

A healthy authenticated Runtime can hold a synchronization callback or its native write longer than the negotiated offline interval. Serializing heartbeat processing behind that callback, or requiring a writer before heartbeat admission, closes the socket while the original native operation is still pending. Transport expiry then obscures the pending operation without establishing its durable outcome.

## Decision

Only strictly parsed heartbeats on an already authenticated socket select fresh read-only Service maintenance admission. The original Service operation is retained before awaiting admission, and suspension, callback lifetime and the original Runtime/Store remain checked. A fresh storage snapshot validates the canonical active registration, member account, deployment and exact current connection handshake/epoch before renewing the lease and echoing. The echo acknowledges liveness, not durable presence or synchronized content.

Each socket retains at most one original presence transaction. Later validated heartbeats may update its pending timestamp without starting another writer. That finite transaction rereads canonical identity and retains the original socket's final COMMIT guard. Its actual storage failure reaches redacted diagnostics even after socket closure. The original Service operation and receive-window charge remain held until that transaction settles.

Heartbeat processing uses the socket's existing bounded pending owner. Every data frame captures a fixed preceding receive prefix; later heartbeats cannot extend that prefix indefinitely. Heartbeat validation order, predecessor references and first presence completion remain part of close and maintenance drainage. Ordinary data admission and every batch/blob domain COMMIT and acknowledgment check are unchanged. The [machine connection decision](../../implemented/architecture/2026-11-08-organization-machine-connections.md) still owns registration and epoch semantics.

## Alternatives considered

**Increase the offline interval.** This postpones expiry without allowing control traffic to progress while the same operation is held.

**Reuse cached authorization for heartbeats.** A retained registration or admission result can outlive revocation, deployment change or maintenance suspension. Each heartbeat instead reads current canonical state.

**Echo only after presence commits.** Presence is an availability sample, while the SQL writer can be legitimately occupied by the very operation whose connection needs renewal. Synchronization acknowledgments still require their original durable result.

**Detach presence or introduce another socket queue.** Detached writes can outlive the Service or disappear from failure observation. A separate unbounded queue also weakens receive limits and drainage. The original owner retains the finite write and every predecessor reference.

## Consequences

Authenticated liveness can progress while an accepted data owner or writer is held, with the original sixteen-operation and byte limits and negotiated deadlines. Durable last-seen sampling can lag an echo and cannot confer authority. Fresh canonical reads remain required; no protocol, persisted format, public API or authorization cache is added. The [postmortem](../../../postmortem/0204-service-sync-writes-blocked-authenticated-heartbeats.md) distinguishes the controlled regression receipts from the still-required complete capacity acceptance.
