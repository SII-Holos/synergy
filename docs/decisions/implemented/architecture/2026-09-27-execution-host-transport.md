# Decision Record: Transport a thin execution host independently of Agent Runtime

Status: implemented

## Problem

Deploying the complete Agent Runtime per conversation couples compute cost and state to disposable containers. Native and remote execution also need identical deduplication, completion and output semantics without depending on Synergy Link.

## Decision

Local Runtime owns a thin Execution Host implementing the Harness Executor protocol. Its native process owner, receipt spool and physical claims serve both direct native execution and transported execution. HTTP/OpenAPI provides controls, SSE provides resumable output, and WebSocket provides binary duplex input and output. Authentication and allocation generation are required on every request. Closing a transport does not cancel its process.

A dropped WebSocket output or terminal-status frame closes the connection with retryable status 1013. The consumer reconnects from its last received cursor; a dropped binary frame never advances the sender cursor. An enqueued frame still waits for drainage. This follows [Bun's WebSocket send-result contract](https://bun.sh/docs/runtime/http/websockets#backpressure): a dropped frame and a queued frame require different handling. Deterministic transport regressions cover both dropped frame kinds and retained replay without cancelling or releasing the execution.

The Docker provider uses Docker Engine's authenticated API for the same lifecycle on local and remote daemons. It creates an identity-labelled container and network, persists credentials through the existing secret vault, and fences container restarts with an incarnation receipt in Agent Storage. Partial allocation recovery uses the original request identity and is permitted only before work admission. Bind paths belong to the daemon host and volume deletion is not part of compute reclamation.

The image contains only the executor and native process owner. Its privileged supervisor keeps private credentials and receipts; commands run as UID 1000 with a separate environment. Read-only root storage, resource limits, private temporary storage and capability reduction constrain the container. Remote listener deployment requires TLS.

Execution input files and compiled containment profiles belong to that same host. Input staging validates bounded immutable bytes against the execution identity, and acknowledgement releases them after saving. The Agent retains both a stable compiler-intent digest and the actual compiled command digest: retries may compile new temporary paths but must reconcile the original command receipt. Hashing only generated arguments would reject equivalent retries, while accepting an operation ID alone would let changed commands reuse another result.

Docker command containment reuses the Linux profile compiler and helper inside the image. Nested user and PID namespaces require namespace syscalls and an outer procfs without locked child mounts. The provider retains Moby’s remaining seccomp policy, read-only sysfs, capability reduction and separate command UID; it does not enable privileged mode or grant SYS_ADMIN. AppArmor-enabled daemons require the supplied `synergy-execution-v1` profile, which permits nested mounts and pivoting while retaining Moby's other restrictions. Operators load that named policy on the daemon host; the provider never disables AppArmor or changes host policy. This increases the namespace-related kernel surface compared with Docker’s default profile. The source and license of the pinned profiles live beside their adapter. A host that forbids unprivileged namespaces rejects contained execution instead of silently bypassing policy.

## Alternatives considered

**Run an Agent Runtime in every container.** This duplicates model configuration, business storage and lifecycle recovery in disposable compute. The executor owns only resource-local execution facts.

**Use Synergy Link as Environment transport.** Link independently connects tools and hosts and has a different lifecycle. Coupling them would conflate unrelated destinations and make core execution depend on an optional module.

**Use Docker exec as the entire protocol.** A command channel alone does not establish deduplication receipts, descendant completion, output replay or save acknowledgement. Docker manages allocation while the Execution Host owns these semantics.

## Consequences

The host image must be built and available to each selected Docker daemon. Transport failure leaves inspectable operations and does not authorize repetition. Immutable allocation identity excludes external container restarts from transparent recovery. Workspace persistence remains a separate service and must acknowledge a checkpoint before execution claims can be released.
