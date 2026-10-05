# Decision Record: Derive search protection from durable root history

Status: implemented

## Problem

Process-local fetch attempts disappear when a Runtime restarts, while failure analysis over the model working set loses attempts hidden by compaction. Embedded search tools need the same protection without duplicating the generic algorithm or adding another authority store.

## Decision

SearchGuard reads the requested root segment through the canonical newest-first message index and hydrates only that root's assistant ToolParts. Completed and errored attempts provide signatures and failure records. Web fetch admission derives the root from its persisted assistant. Failure analyzers use the same durable reader with their registered tool sets. Remove the process-local attempt map and recording API.

Query signatures canonicalize set-valued filters and preserve meaningful filter changes. URL paths retain case. HTTP 408 and timeout diagnostics share the timeout category. Explicit completion failure metadata must be a supported category. Newest-first message reads preserve storage failures while tolerating a genuinely deleted record.

## Alternatives considered

**Retain the process map alongside durable records.** Two attempt sources can disagree after reload or compaction.

**Read only model context.** The context window is a projection and may omit relevant attempts.

**Store dedicated search receipts.** Existing canonical ToolParts already carry the admitted input and terminal outcome; another ledger adds migration and reconciliation work.

## Consequences

Search tools require a persisted assistant and user root. Host composition selects search tools and analyzers through public APIs. Another root isolates a fresh task; steers retain previous attempts. Missing or unreadable required authority stops admission. No stored format changes or online JSON compatibility reader are introduced. Tests use owned SQL Runtimes and actual HTTP, persist terminal attempts, reopen the store and omit attempts from the model context.
