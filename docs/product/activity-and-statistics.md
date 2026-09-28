# Activity and Statistics

Synergy combines retained execution usage with activity derived from persisted sessions. The Web Library workbench presents this as **Usage** beside Library-specific health and learning statistics; the installed CLI exposes the same workspace snapshot through `synergy stats`.

## What the Snapshot Describes

The snapshot combines several independent dimensions:

- sessions, messages, turns, projects, active days, and activity streaks
- input, output, reasoning, cache-read, and cache-write tokens
- recorded cost, average cost and tokens per turn, and prompt-cache reuse
- calls and cost by model and agent, including delegated child-session counts
- calls, success/error counts, and average duration by tool
- additions, deletions, changed files, and net code change reported by file tools
- pinning, duration buckets, compaction, retry, and error behavior
- Channel versus interactive/unattended session activity
- daily totals, hour-of-day activity, trends, and heatmaps

These are operational summaries of Synergy's own stored records. Cost keeps API estimates, subscription API equivalents, provider-reported charges, and legacy recorded cost separate. Estimates are not invoices. Unknown prices or billing modes remain explicit in the structured usage API. Code-change totals describe changes observed in Synergy tool results, not every change that may have occurred independently in a repository.

## Freshness and Recalculation

Consumption is retained independently of the canonical transcript and raw response archives. Deleting a conversation does not delete its usage. Clearing usage is an explicit revision-bounded operation that preserves active work and prevents rebuild/import resurrection. Historical capture runs in resumable background pages and reports its coverage.

The existing activity snapshot still stores:

- one digest per session
- daily aggregate buckets
- a full snapshot
- a watermark containing the last observed session update and known session IDs

An incremental update re-digests new or changed sessions, subtracts previous contributions, removes deleted-session digests, updates affected day buckets, and projects canonical usage totals into the existing snapshot. Activity/file-change dimensions retain their session sources. Reading stats returns the cached snapshot when one exists. The Web **Sync** action and `synergy stats --recompute` discard the old watermark and rebuild the derived view while reporting scan, digest, bucket, and snapshot progress.

Deleting derived activity records does not delete sessions or the usage ledger; recomputation recreates the activity view. Backend records belong to the Agent database and should be changed through their owning APIs.

## Surfaces and Scope

The Web Usage surface summarizes the installation across the home Scope and known project Scopes. Library statistics shown beside it are a separate view over Memory and Experience records in `library.db`.

`synergy stats` supports formatted and JSON output, optional model/tool display limits, time-series trimming through `--days`, and full recomputation. The current `--project` option triggers recomputation but does not filter the resulting installation-wide snapshot; integrations that need project-only consumption can use the structured usage API with `scopeID` rather than assume that flag has narrowed the result.

Derived storage and backup behavior are documented in [Storage and Paths](../reference/storage-and-paths.md). Library-specific inspection is documented in [Knowledge](knowledge.md).

Web statistics show each snapshot’s computation time. Refresh failure retains the previous snapshot with a local retry. Day ranges are calendar intervals ending on the displayed snapshot’s computation date, with empty dates filled as zero activity and explicit start/end labels. Date labels retain their calendar date rather than parsing date-only keys as UTC instants.

The additive [usage accounting API](../architecture/usage-accounting.md) supplies tokens, cache coverage, billing bases, transport rates, timing, retries, tools, latest primary context, and session/descendant/purpose breakdowns for future displays. Input totals remain valid when cache splits are unknown; reasoning is included in output, and cache creation counts in the cache-hit denominator. Days follow actual request time in the requested IANA timezone. Existing frontend display logic is unchanged.
