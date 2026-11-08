# Decision Record: Independent organization service storage and protocol

Status: implemented

## Problem

Team identity and authorization need durable service-owned records without another Agent executor. Starting the normal Agent Runtime also starts execution recovery and model-related services, which are inappropriate for a collaboration control service.

## Decision

The organization service uses an explicit Harness Runtime context and Storage Handle, the existing Home process lock and the central migration runner. It owns a separate SQL namespace and registers only organization migrations. Its startup never opens the Agent Runtime lifecycle. Strict protocol schemas and an independent generated SDK separate organization transport from Runtime transport.

The installable component contributes lazy commands to the single CLI parser and has no service migration registration hook. Its command entry declares owner initialization, bypassing the parser's ambient Home initialization and log mirroring. The handler validates an explicit absolute Home, then opens the independent service. Initialization secrets go to an exclusively created private file, and readiness output contains no credentials. The listener owns its signals, admitted work and shutdown.

## Alternatives considered

**Open the complete Agent Runtime with fewer routes.** Route visibility does not remove execution recovery, background services or implicit model discovery.

**Build another storage engine and migration framework.** This would duplicate the existing SQLite/PostgreSQL transactions, fencing, receipts and migration guarantees.

**Mount organization routes on the Runtime server.** Deployment ownership and authentication differ; coupling them would make it harder to deploy the organization service independently and keep member machines away from organization storage.

**Use a second CLI parser or ambient Home setup.** Another parser duplicates installed command dispatch and help. Ambient initialization can write configuration or telemetry before the independent service validates its Home or acquires ownership; owner initialization preserves the existing parser while keeping those writes with the service.

## Consequences

The service can persist deployment identity, survive restart and expose its own API without executing work. It must explicitly drain its admitted operations and dispose its acquired storage and lock. Runtime bridge integration remains a separate owner and cannot turn the service into an executor.
