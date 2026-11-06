# Decision Record: Project Cortex tasks as summaries

Status: implemented

## Problem

Cortex observation distributes the same task through creation, completion, progress replacement, list and bootstrap responses. A complete Task includes the launch prompt, output, structured-output schema and error text. Retaining those bodies in replay journals and the Web runtime index duplicates durable child Session data. Lazy journal pruning also retains expired payloads indefinitely in an idle Scope, while map-only HTTP detail and output reads become unavailable after task eviction.

## Decision

`CortexTypes.TaskSummary` is the single observation projection. One schema-backed projector selects task and Session identity, description, Agent/model, execution role, category/DAG identity, status, lifecycle times, launch-failure indication, scalar usage and necessary progress counters/tool status. It excludes prompts, results, output schemas, error text, tool controls, plugin ownership and textual/recent-tool progress. Cortex creation/completion/replacement events, HTTP lists and bootstrap task collections all use that projection. The Web global task index and shared Session data view consume summaries and preserve existing reconciliation and post-stamp write tracking.

The complete Task remains the execution model. The child Session stores its durable prompt, task controls and terminal result. Preparing a legitimate reused child writes a fresh canonical Cortex delegation even when that child has no existing Cortex metadata; prior completion, settlement and delivery fields do not carry into the new task. Detail and output reads reuse the Cortex child-Session reader after live eviction; current Scope, parent Session, child parent identity, task identity and visibility are checked for both live and durable reads. Explicit full Session reads revalidate the child identity before returning its body.

Explicit HTTP detail/output requests accept optional expected `parentSessionID` and child `sessionID` query parameters. A qualified read selects that child through the same authorized reader, independently of another parent's live task with the same task ID. Unqualified reads use the live owner when it exists; cold reads enumerate existing Scope Session records and return 404 if the task ID is ambiguous. Transcript imports preserve task IDs while remapping Session identities, so neither scan order nor a preference for an original or imported Session determines the result. There is no second task registry or lookup cache. Hidden, foreign, mismatched and missing tasks return 404.

The explicit Agent result panel reads the authorized full Cortex task using the notification's task, parent and child identities rather than reading bodies from public Session summaries. It checks those identities on the response and retains the existing recorded full `task_output` Part presentation and fallback. The opened child Session footer lazily reads qualified full details only while its terminal view is active, validates task/parent/child identity and current server/Scope ownership, and retains only a short component-local preview.

Each nonempty Scope replay journal owns one unreferenced expiry timeout. Cleanup releases expired payloads even without another publication or replay, and rearms for the next retained event when necessary. Scope disposal cancels the timeout and clears the journal before notifying subscribers, including when no wildcard subscribers exist. Expiration leaves the epoch and allocated sequence unchanged; missing prefixes still require the existing reset/resync path. Task compaction, eviction, capacity ownership and busy-task cleanup retries retain their established behavior.

## Alternatives considered

**Keep complete Tasks and shorten replay retention.** This still retains full bodies in live clients and repeats them on progress updates; lowering retention also forces more reconnect resyncs without changing the data being distributed.

**Truncate task bodies in observation payloads.** Partial bodies are neither complete task details nor a stable summary, and consumers cannot distinguish a complete result from omitted content. A field projection avoids transporting bodies without truncating the canonical result.

**Add a durable task registry or a parallel full-payload event feed.** Either creates another persistence or synchronization owner that can disagree with the existing child Session and event sequence. Explicit detail reads already provide the required access.

**Choose the first durable task-ID match or prefer an original Session.** Imports retain task IDs, and a task ID alone cannot express which transcript the caller is viewing. Such selection can silently display another Session's result; expected Session identities and explicit failure on cold ambiguity preserve caller intent without an import migration.

**Keep lazy pruning or use a Runtime-wide periodic sweep.** Lazy pruning does not release idle payloads. A global sweep adds a cross-Scope lifecycle owner and work for empty journals; a cancellable per-journal expiry timer follows the existing Scope owner.

## Consequences

Observation cost is independent of prompt, output and stack size, while explicit authorized detail reads retain complete durable content. Scalar usage deliberately omits detailed accounting breakdowns from the task table; canonical Session usage remains available through its existing owner. Cold unqualified HTTP task-ID lookup traverses Scope Session records instead of retaining a task lookup cache, and rejects ambiguity. Callers viewing a specific transcript supply its parent/child identity. Historical records without a saved launch prompt cannot acquire the original prompt retroactively.

The API schema changes require SDK regeneration. There is no legacy complete-Task observation feed. Journal limits, sequence coverage, reconnect recovery, global-index ownership and the [task retention safeguards](../bug-fix/2026-10-21-retain-and-release-failed-execution-payloads.md) remain unchanged. The owning runtime rules remain in [Cortex delegation](../../../architecture/cortex.md) and [frontend data sync](../../../architecture/frontend-data-sync.md).
