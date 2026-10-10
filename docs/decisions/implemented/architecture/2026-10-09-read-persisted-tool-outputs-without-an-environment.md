# Decision Record: Read persisted tool outputs without an Environment

Status: implemented

## Problem

A truncated API result must remain readable after its original Runtime disappears. Using its former absolute path as authority retains a Host dependency. Copying that output into a live mounted Workspace also makes recovering an API result depend on execution availability.

## Decision

An embedding application can register `StoredToolOutput.persistence()` and the `read_tool_output` tool together. Complete UTF-8 content is an immutable Storage binary with checksum metadata committed after upload. The public reference is `tool-output://<id>`. The reader uses only the current Storage namespace, needs no Workspace or Environment, and returns bounded byte pages with an exact continuation offset. UTF-8 scalars are never split. JSON escaping is included in the model-facing output budget.

Offline import may register exact historical references in the same transaction. These aliases are literal namespace-scoped records, not filesystem fallbacks or path-prefix permissions. A collision, missing blob or invalid offset fails explicitly. Save limits complete output to 32 MiB; the reader exposes at most 8 KiB of raw text per tool call. Applications that retain local storage keep the existing truncation behavior unless they explicitly select this backend.

## Alternatives considered

Treating immutable tool output as a Workspace file creates unnecessary mounting and lifecycle coupling. Interpreting arbitrary historical absolute paths permits ambiguous ownership. Modifying generic file-tool resource selection for one artifact type expands the security boundary unnecessarily.

## Consequences

The application must expose the reader whenever it selects this truncation backend. Legacy output evidence can remain unchanged while its exact reference is imported. No automatic retention deletes referenced historical outputs. Tests cover fresh Runtime recovery, UTF-8 continuation, interrupted publication, exact alias collisions, missing objects and cancellation; the storage test is registered for real PostgreSQL.
