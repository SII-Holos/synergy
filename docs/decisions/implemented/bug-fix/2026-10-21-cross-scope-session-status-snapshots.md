# Decision Record: Order Runtime-wide status snapshots by request-period writes

Status: implemented

## Problem

The global status endpoint returns Sessions from every Scope but its HTTP watermark belongs to Home. Project events use independent epochs and sequences. Comparing those clocks lets a delayed busy snapshot overwrite an idle event the frontend already received. A tracker that clears every status write when any Scope epoch changes also loses one project's ordering evidence when unrelated work publishes. The [incident analysis](../../../postmortem/0082-cross-scope-status-snapshot-resurrected-busy.md) records the real server and browser reproduction.

## Decision

`GlobalRuntimeWriteTracker` maintains a frontend-local status-write revision and stores each status key's own optional event stamp. `loadGlobalSessionStatus()` captures the tracker and revision before dispatch. The response merges only writes observed after dispatch, including an idle deletion, over its authoritative snapshot. A response from a replaced tracker or disposed provider cannot publish. Existing local state written before dispatch converges to the snapshot, including removals, so missed terminal events remain recoverable.

Scope bootstrap continues comparing the owning Scope's epoch/sequence, using the stamp stored for each status key. Foreign status and Cortex events cannot clear that evidence. Accepted Scope status snapshots and derived `working` writes participate in the same request-period revision tracking; snapshot adoption preserves the existing event stamp. The change does not alter the event protocol, backend lifecycle, sidebar classification or delegated-child behavior.

## Alternatives considered

**Introduce a Runtime-wide server sequence or per-Scope watermark vector.** Either can provide comparable server-side ordering, but requires transport and API changes for a defect the frontend can prevent using its existing request lifetime.

**Fetch status independently for every Scope.** This provides comparable Scope watermarks but duplicates the global endpoint, adds request fan-out and depends on discovering every relevant Scope.

**Keep every local status whenever epochs differ.** This preserves stale busy entries after missed idle events indefinitely. Request-period writes preserve concurrency without preventing later snapshot convergence.

**Hide running icons after a terminal reply or a timeout.** A Session can legitimately keep processing queued work or have running delegated tasks. Changing presentation would conceal valid activity rather than repair state ordering.

## Consequences

Delayed global reads cannot restore completed project Sessions or delete concurrent new work, while Sessions not observed through events still initialize from the snapshot. The tracker retains one small write record per observed status key for its frontend Runtime lifetime. Events observed during a request conservatively win even when the server may have read that key later; a subsequent request converges pre-request state normally. No polling, per-event refetch, persisted migration or wire change is added.

The existing GlobalSync DOM regression covers independent Scope clocks, terminal deletion, concurrent starts, snapshot-only Sessions and superseded Runtime replies. Focused tracker tests cover stale-state convergence, derived pauses and Scope snapshot ordering. The full application was checked with a real isolated backend, local synthetic inference, Chromium and a held actual HTTP response; only inference and network timing were controlled.
