# Paused Session Transfer

## Ownership and supported sessions

`SessionTransfer` in Harness owns manual cross-Host migration of a paused interactive root Session. `SessionTransferWorkspace` is a Runtime-scoped Host interface registered during composition; Local Runtime implements native directory capture and materialization. Server exposes `/session-transfer` routes through the generated SDK. Web uses the existing server selector inventory and keeps the task paused after transfer. See the [decision](../decisions/implemented/architecture/2026-10-10-distributed-host-runtime.md) for scope and trade-offs.

Both Hosts must be online and have the same platform, installation version and selected component identities. Production Web SPA responses allow HTTP and HTTPS connections for user-configured server destinations; target CORS and authentication still apply. Document, frame and script policies retain their separate restrictions. There is no Coordinator, automatic failover, Host-count requirement or ongoing Workspace replication. A target uses its own provider credentials, plugin approvals, configuration and execution environment. Session permission approvals and pre-authorized actions are cleared; the control profile remains the user's selected policy.

A source must have a pause latch and no active SessionManager lease, LoopJob background work, unresolved tool call or active Environment operation. A root with any child Session, bound workflow, unattended interaction, endpoint, Cortex binding or domain continuation is rejected. Browser/Computer tool history and interrupted tools with unknown side effects are rejected. Source attachments must have durable artifact or asset bytes.

A Session has one native directory Workspace or no Workspace. File-history references must point to that selected Workspace. Active mounts, shared writable views and other backends are rejected. Native capture takes the existing Workspace write coordination claim and refuses Workspace overlap with Runtime data except for the narrowly identified private received Workspace directory, which can transfer onward to another Host. Git roots must have their own `.git` directory and self-contained objects, without linked worktrees, alternate object stores or worktree-bound configuration. Workspace bytes include dirty, untracked and ignored files, binary files, modes and supported relative links; capture fails on unsupported entries.

## Handoff and recovery

```mermaid
sequenceDiagram
  participant U as Web client
  participant S as Source Host
  participant T as Target Host
  U->>T: Read stable Host identity
  U->>S: Prepare paused Session for target
  S->>S: Persist gate, capture frozen ZIP and digest
  U->>S: Download frozen ZIP
  U->>T: Stage ZIP
  T->>T: Reserve identity, verify bytes and history, materialize private Workspace
  T-->>U: Prepared receipt
  U->>S: Commit prepared receipt
  S->>S: Persist committed gate
  S-->>U: Activation proof
  U->>T: Activate with proof
  T->>T: Publish Session, evidence and indexes in one transaction
  T-->>U: Activated receipt
  U->>S: Complete with activated receipt
  U->>T: Open paused Session; Continue is a separate user action
```

Source phases are `preparing`, `prepared`, `committed`, `completed`, and `cancelled`. All retries retain the migration UUID and bound target. Capture failures retain the source gate and allow retry or precommit cancellation. A prepared retry reads the same frozen payload; a committed retry retrieves the existing destination receipt and activation proof. An activated retry returns the same receipt without publishing or executing again.

The target persists an identity reservation bound to the migration UUID, payload digest and proof hashes before copying files. An interrupted receive can resume the same payload after restart. Prepared Sessions remain outside normal Session lookup and navigation. An unrelated Session cannot claim a reserved identity. Payload verification, private Workspace materialization and snapshot-pack validation finish before the prepared receipt is published.

Commit validates every receipt identity and digest and durably records the source gate before revealing the random activation secret. The target stores only its hash. The destination validates the frozen ZIP and Workspace again before activation. A separate cancellation secret is disclosed only by source cancellation before commit; the target requires that proof before discarding staging. Activation and discard are serialized per migration. After commit, errors never release the source gate or authorize another target.

Source execution admission checks `SessionTransferGate`; ordinary Storage transactions reject changes to gated Session records, indexes and snapshot ownership. The mutation guard covers batched records, binary artifacts, portable record restoration, subtree deletion and pruning. Target activation has a Runtime-bound narrow admission context for its own reservation. Read-only history remains accessible. Web projects the transfer state into `Session.Info.transfer` and disables composer mutations. That field is derived from migration state and excluded from persisted Session info.

## Data and destination identity

The version 1 ZIP manifest binds source and target Host identities, Scope, Session ID, activation and cancellation hashes, records, artifacts, Workspace chunks and historical snapshot packs. Every declared file has its byte length and SHA-256; entry inventory must match exactly. Duplicate record keys, duplicate artifact keys, unrelated record owners and malformed dependency metadata are rejected. Per-entry size is limited to 64 MiB, total ZIP payload to 64 MiB and inventory to 100,000 entries. The Web client relays the ZIP using a browser Blob; this is a whole-package transfer without resumable network chunks.

Source capture includes the complete Session record subtree, per-Session usage records, Session binary artifacts and referenced assets and full tool outputs. Asset bytes are captured through their domain reader, including native cache storage. Canonical tool outputs retain their records; exact historical output aliases retain their mapping. Native truncated outputs are read only from retained regular files inside the source tool-output directory and converted into checksummed records plus exact aliases. Messages, parts, compaction, Inbox, Rollout journal and persisted operation evidence retain their identities and values. Snapshot export includes all historical roots referenced by the Session. Target snapshot objects are protected under a private migration owner until activation adopts them into the real Session owner; cancel and successful activation release the private owner. Whole database files, global Library, unrelated Sessions, global command receipts and transient process state are excluded.

Destination activation preserves Session and message IDs. A target with an existing Session ID rejects staging; there is no merge or overwrite, including a transfer back to a Host that retains the same Session ID. Scope keeps its logical ID. Existing destination Scope metadata is retained; a missing project Scope is registered without the source local directory. A new native Workspace identity binds the private destination directory. Known structured Workspace references are remapped; original historical paths are evidence and never execution authority. `environmentID` and active selection are cleared. The destination allocates its own Environment when continued.

The target validates required dependency bytes, asset IDs, asset/tool-output checksum metadata and existing destination records before preparation, then checks collisions again during publication. Immutable assets are materialized through the Asset domain before Session publication; this can leave reusable asset bytes after a failed activation, but never publishes a Session or grants execution. Full outputs and aliases use target Storage, so original paths do not grant filesystem authority. Binary preparation happens outside the retryable transaction; publishing records, binaries, Session indexes and activation receipt happens inside one business transaction. No model, tool or trace replay is part of transfer.

## Persistence and storage lifecycle

Source migration state, proof secrets and gate remain durable after completion. Destination activation receipts remain durable after temporary ZIP cleanup. Gate and proof state are not part of the transferred Session records. These new namespaces have version 1 bodies; no existing record format is upgraded. [Storage paths](../reference/storage-and-paths.md) lists the physical transfer directory.

Successful completion removes source transfer ZIP and temporary files. Successful target activation removes its ZIP while retaining the published Workspace directory. Precommit source cancellation removes its ZIP; proof-authorized target discard removes the unpublished directory and identity reservation. An offline target retains its staging until the client can deliver cancellation or retry. A new transfer to the same destination first reissues the previous cancellation proof and discards its reservation; a failed discard leaves the source cancelled and writable. Source user files and retained history are not deleted as part of migration. Cleanup failures are retryable and cannot reverse execution ownership.

Verification covers paused-only admission, owner gates, identity conflicts, cancellation proofs, response loss, receiving and cutover restart, same-ID activation, native files and modes, independent destination Workspace, historical objects, assets, canonical/native/historical full tool outputs, staging tampering and continued execution through isolated real HTTP Hosts. See [development acceptance](../../.synergy/skill/develop-synergy/SKILL.md#verify-paused-session-transfer).
