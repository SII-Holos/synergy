# Activity and Statistics

Synergy derives a local view of how an installation has been used from its persisted sessions. The Web Library workbench presents this as **Usage** beside Library-specific health and learning statistics; the installed CLI exposes the same workspace snapshot through `synergy stats`.

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

These are operational summaries of Synergy's own stored records. Cost reflects cost values recorded on assistant messages; it is not an invoice or a replacement for provider billing. Code-change totals describe changes observed in Synergy tool results, not every change that may have occurred independently in a repository.

## Freshness and Recalculation

Stats are derived rather than written into the canonical session transcript. Synergy stores:

- one digest per session
- daily aggregate buckets
- a full snapshot
- a watermark containing the last observed session update and known session IDs

An incremental update re-digests new or changed sessions, subtracts previous contributions, removes deleted-session digests, updates affected day buckets, and rolls all digests into a new snapshot. Reading stats returns the cached snapshot when one exists. The Web **Sync** action and `synergy stats --recompute` discard the old watermark and rebuild the derived view while reporting scan, digest, bucket, and snapshot progress.

Deleting the derived records does not delete sessions; the next full computation recreates them. Conversely, editing derived JSON by hand does not change session history and can leave the snapshot internally inconsistent.

## Surfaces and Scope

The Web Usage surface summarizes the installation across the home Scope and known project Scopes. Library statistics shown beside it are a separate view over Memory and Experience records in `library.db`.

`synergy stats` supports formatted and JSON output, optional model/tool display limits, time-series trimming through `--days`, and full recomputation. The current `--project` option triggers recomputation but does not filter the resulting installation-wide snapshot; integrations that need project-only statistics must aggregate by `scopeID` from authoritative session data rather than assume that flag has narrowed the result.

Derived storage and backup behavior are documented in [Storage and Paths](../reference/storage-and-paths.md). Library-specific inspection is documented in [Knowledge](knowledge.md).
