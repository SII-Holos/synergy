# Decision Record: Indexed storage upgrade traversal

Status: implemented

## Problem

Large JSON upgrades enumerate their file inventory repeatedly and verify every imported record. An OR-based cursor lets SQLite filter the already-visited prefix of a kind index on each page. Whole-namespace verification and portable export also order by columns without a matching index, producing a namespace scan and temporary sort for every page. Work grows disproportionately as the dataset increases, even when the database fits on disk.

## Decision

Ordered queries express the cursor as a row-value comparison of `order_key` and `key_id`. Full record walks use the existing `(namespace, key_id)` primary index with a strict key bound and a 256-record page size. Verification and portable export share this traversal inside their existing read transaction. Public query ordering, revision tombstones, namespace isolation, receipt ordering and pending-event ordering remain intact. No persisted schema upgrade or additional index is required.

The query bound follows SQLite's [scrolling window queries](https://www.sqlite.org/rowvalue.html#scrolling_window_queries). The owning implementation cites this source beside the bound. Real SQLite query-plan regression tests require cursor seeks and reject repeated sorting; the shared SQLite/PostgreSQL contract exercises ties, descending pages, deleted cursors and complete exports.

## Alternatives considered

**Add a namespace/order/key index.** This accelerates ordered whole-namespace queries, but duplicates ordering and key data for every record. A local 100,000-record layout prototype added about 12.1 MiB for this index. Maintenance operations only need to enumerate every live record and can use the existing primary index.

**Change only the cursor expression.** This fixes indexed kind traversal, but whole-namespace traversal still lacks the matching ordering index. In a SQLite 3.51.3 query prototype with 100,000 synthetic records, a late kind page fell from about 6.96 ms to 0.10 ms while an unfiltered page still took about 109 ms and sorted its candidates. These are warmed single-page measurements, not whole-upgrade timings.

**Change the backup and file-inventory formats together.** Compact migration metadata and packed immutable backups can reduce upgrade space, but introduce separate recovery and compatibility requirements. They do not remove repeated SQL scans and remain separate work.

## Consequences

Maintenance record ordering follows the key hash. Portable archives remain checksummed and preserve logical data and revisions; a newly exported archive can have a different byte order and checksum from an older export of the same records. Ordered application queries keep their existing ordering. The change reduces traversal work without changing the current backup layout, capacity admission formula or retained migration metadata, so it does not by itself make a large Home upgrade fit in less disk space.
