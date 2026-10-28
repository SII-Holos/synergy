# Decision Record: Reuse execution trajectory reads and static projections

Status: implemented

## Problem

Oversized execution checkpoints advanced the same frontend generation as transport reconnects, restarting trajectory pages during ordinary snapshot delivery. Reactive anchor changes and explicit latest navigation also issued equivalent requests independently. Aborting an inactive reader did not invalidate every late completion.

The backend shared task-tree preparation but recomputed static statistics on every summary read and rebuilt activity and process rows for each page. Its coalescing timer stopped excluding another publisher as soon as asynchronous refresh began. Slow publication therefore permitted overlapping full-list projection and could acknowledge a revision changed by a concurrent HTTP read.

## Decision

Trajectory connection generations track transport recovery rather than ordinary checkpoint delivery. Existing metadata revision gaps restore the reading window and expanded branches, including gaps received while a page is pending. A pending page must reach the required revision before recovery settles. Equivalent queries within one connection share one promise, and the lease's consuming predicate controls both subscriptions and HTTP reads. Inactivity invalidates request generations; page and scoped-summary completions validate their captured cancellation state. Journal coverage updates link to the previously delivered detail revision instead of creating a false trajectory gap.

Each task tree retains revision-bound selected nodes, static summary preparation, canonical timing inputs and lazy process/records projections. The root and at most four round selections share these derived values. Summary reads retain canonical interval-union timing through fresh sampling rather than rebuilding accounting or extrapolating server wall time. Public summary results are detached from the private preparation. Revision changes invalidate derived values; inspector bodies remain lazy.

The refresh publisher remains exclusive through event delivery and protects its entry from LRU eviction. Invalidations arriving during that interval request another coalesced pass independently of the data cache's dirty flag. Successful delivery commits its captured revision and row baselines without clearing changes belonging to a newer revision. Cancellation, eviction and disposal release unused refresh requests.

## Alternatives considered

**Treat every checkpoint as a reconnect.** A checkpoint is a transport-size choice, not evidence that the trajectory lost an update. Metadata revisions already identify genuine gaps.

**Cache the complete sampled summary indefinitely.** This would stop active root, task and round clocks. Static preparation is reusable, but canonical timing must be sampled on each read.

**Remove the initial trajectory GET and rely on the projection.** Initial projections do not contain the complete historical trajectory window or its paging cursors, so this would lose explicit history loading.

**Add persistent trajectory indexes in this fix.** A bounded cold-query redesign changes storage and search preparation. This change removes redundant work without altering complete-tree selection or evidence accounting.

## Consequences

Ordinary checkpoints and latest navigation do not restart equivalent in-flight page reads. Unchanged summary and page requests avoid repeated static aggregation and list projection, at the cost of bounded per-tree derived references and timing inputs. Cold tree preparation still covers its descendants, and filtering and paging still inspect the selected list. This does not claim constant-time cold loading.

Behavioral regressions cover normal checkpoint delivery, latest-request coalescing, real reconnects, late aborted results, pending-page and legacy branch gap recovery, detached public results, same-revision projection reuse, active root/child/round clock sampling, audit invalidation, and a publication held while HTTP consumes newer changes under LRU pressure. The implementation preserves scoped evidence reads, shared cancellation and existing protocol schemas.
