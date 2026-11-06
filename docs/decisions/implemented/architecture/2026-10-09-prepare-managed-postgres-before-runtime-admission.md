# Decision Record: Prepare managed PostgreSQL before Runtime admission

Status: implemented

## Problem

An embedding service starts independent Runtime processes on demand. Letting the first request initialize shared database objects couples request latency and availability to deployment work. Missing indexes can require long DDL even when no history belongs to the new namespace.

## Decision

Expose `TransactionalStore.preparePostgres` as an explicit deployment or maintenance step. Managed Runtime opens select `schema: "verify"`: one catalog inspection requires every shared object and fails without creating or repairing missing objects. Existing namespace ownership, recovery admission and storage version checks remain mandatory. The generic default initializer remains available to standalone hosts, and read-only opens never initialize schema.

## Alternatives considered

Skipping all verification would allow a partially prepared database to accept work. Copying schema into each embedding application's migration system would create multiple owners for the Core schema. Starting a throwaway Runtime to initialize tables would unnecessarily claim a product namespace.

## Consequences

Deployment must prepare the schema before opening managed admission. Definition-changing migrations remain owned maintenance operations; presence verification does not replace those migrations. Real PostgreSQL contracts cover idempotent preparation, managed reopen, missing-object rejection without repair and preserved records. Local SQLite checks cannot establish those PostgreSQL properties.
