# Decision Record: Managed Workspace file transfers

Status: implemented

## Problem

An embedded host needs trusted, bounded file transfers without choosing an execution Environment. Managed file streams previously loaded the complete file before returning, and native-to-managed imports could not replay a completed operation after an interrupted response.

## Decision

Managed streams read at most four MiB per pull and retain their Workspace-owned resource until completion, cancellation or disposal. Live views additionally retain an Environment file admission. Each read validates the selected generation and content version; concurrent replacement fails explicitly. The public serveFile port accepts an explicit limit up to 512 MiB while retaining the existing default limit.

Managed importEntry accepts an optional stable operation ID. Core's WorkspaceOperations owns the persisted input digest and publication: replay does not advance the revision, and changed source content or destination conflicts are rejected. Native imports retain their existing conflict behavior and reject an idempotency ID. Sources remain explicitly validated by the trusted host.

## Alternatives considered

Whole-file buffering makes transfer memory proportional to user content. Host-maintained manifests duplicate Core authority. Retrying a fresh import after a lost response confuses already-published content with a conflicting write.

## Consequences

Hosts can stage a bounded stream in private storage and import through one Core publication mechanism. Streaming limits are explicit and do not lift model editing limits or grant filesystem access. SQLite and PostgreSQL tests verify replay, conflict, bounded reads and cancellation; native lifetime and selected live-view tests retain their behavior.
