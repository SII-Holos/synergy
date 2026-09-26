# Decision Record: Preserve performance snapshot state

Status: implemented

## Problem

Converting a failed Performance summary into missing data lets presentation defaults imply zero activity or healthy operation. Clearing a successful same-range snapshot on refresh also discards useful evidence. Concurrent range changes and auxiliary requests can overwrite newer state or leave sections permanently loading.

## Decision

The summary resource returns the selected range, attempt time, last successful same-range summary, and error together. Presentation gates summary-dependent content until a snapshot exists, retains and dates stale evidence after refresh failure, and hides old-range data immediately on selection changes. Request generations reject obsolete results. Trend and trace requests belong to the accepted snapshot generation, so a failed refresh does not strand its pending auxiliary requests.

Initial failure provides a retry action and collapsed diagnostic details. A retained stale snapshot displays a warning and disables analysis until recovery. Auxiliary failures remain visible in their own sections without discarding a successful summary. The panel remains a manual snapshot with no background refresh.

## Alternatives considered

**Replace errors with empty data.** Empty results do not establish a zero value or current health, and cannot tell the user whether retrying is useful.

**Clear every result before refreshing.** This discards valid same-range evidence and creates unnecessary blank content during transient failures.

**Use one request generation for summary and details.** A failed same-range refresh invalidates still-pending details belonging to the retained snapshot, preventing them from settling.

## Consequences

Snapshot age and request failure become explicit product states. Range changes intentionally show loading rather than measurements from another range. Behavioral tests cover refresh failure, range races, pending detail settlement, keyboard recovery, narrow layouts, and localized copy.
