# Decision Record: Transport a thin execution host independently of Agent Runtime

Status: implemented

## Problem

Deploying the complete Agent Runtime per conversation couples compute cost and state to disposable containers. Native and remote execution also need identical deduplication, completion and output semantics without depending on Synergy Link.

## Decision

Local Runtime owns a thin Execution Host implementing the Harness Executor protocol. Its native process owner, receipt spool and physical claims serve both direct native execution and transported execution. HTTP/OpenAPI provides controls, SSE provides resumable output, and WebSocket provides binary duplex input and output. Authentication and allocation generation are required on every request. Closing a transport does not cancel its process.

The Docker provider uses Docker Engine's authenticated API for the same lifecycle on local and remote daemons. It creates an identity-labelled container and network, persists credentials through the existing secret vault, and fences container restarts with an incarnation receipt in Agent Storage. Partial allocation recovery uses the original request identity and is permitted only before work admission. Bind paths belong to the daemon host and volume deletion is not part of compute reclamation.

The image contains only the executor and native process owner. Its privileged supervisor keeps private credentials and receipts; commands run as UID 1000 with a separate environment. Read-only root storage, resource limits, private temporary storage and capability reduction constrain the container. Remote listener deployment requires TLS.

## Alternatives considered

**Run an Agent Runtime in every container.** This duplicates model configuration, business storage and lifecycle recovery in disposable compute. The executor owns only resource-local execution facts.

**Use Synergy Link as Environment transport.** Link independently connects tools and hosts and has a different lifecycle. Coupling them would conflate unrelated destinations and make core execution depend on an optional module.

**Use Docker exec as the entire protocol.** A command channel alone does not establish deduplication receipts, descendant completion, output replay or save acknowledgement. Docker manages allocation while the Execution Host owns these semantics.

## Consequences

The host image must be built and available to each selected Docker daemon. Transport failure leaves inspectable operations and does not authorize repetition. Immutable allocation identity excludes external container restarts from transparent recovery. Workspace persistence remains a separate service and must acknowledge a checkpoint before execution claims can be released.
