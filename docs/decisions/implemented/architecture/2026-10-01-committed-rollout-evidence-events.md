# Decision Record: Committed rollout evidence events

Status: implemented

## Problem

An embedded host needs to export model and tool evidence without duplicating the model instrumentation. Capturing after a rollout write leaves a crash gap; exposing the private journal would couple hosts to storage implementation.

## Decision

Expose a typed committed-record notification containing the owner, immutable journal revision, time, relative record key and value. Journal commits and recovery enqueue it inside the evidence transaction. Explicit StorageEventSinks can read referenced artifacts and project their own durable delivery records in that transaction. Capture failure rolls back evidence, its head and delivery together.

The notification has no ordinary Bus effect and does not broadcast evidence to interactive clients. No exporter or product service starts implicitly. Hosts choose records, envelopes, size limits, delivery and acknowledgments.

## Alternatives considered

Capturing the SDK a second time produces competing evidence. Periodic snapshots cannot guarantee capture across a crash. Exporting journal implementations exposes private sequencing and recovery behavior.

## Consequences

Hosts retain one authoritative rollout producer and use the existing portable SQLite/PostgreSQL outbox. The public boundary contains records and artifact references rather than execution internals. Tests verify atomic projection, rollback and subsequent revision/sequence behavior on both storage backends.
