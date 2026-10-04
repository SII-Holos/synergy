# Decision Record: Compact file change cards

Status: implemented

## Problem

File change cards mix confirmed results with capture diagnostics. A warning does not identify an affected file or an action the person can take, while forcing the aggregate counts onto another row. The summary header becomes disproportionately tall relative to the file list.

## Decision

The [change card](../../../../packages/ui/src/components/turn-change-summary-panel.tsx) presents confirmed file counts, aggregate additions and deletions, file rows and Review/Undo actions. Terminal recording states share this presentation. Recording diagnostics remain internal and are not shown in the conversation, Task details or Review; restoration checks still use the authoritative evidence. Pending comparison retains its busy indication and disables Undo. Empty file collections render nothing.

The header keeps the file count and line totals on one line with regular text weight. Its height is comparable to a file row, and its action group can wrap when the available width requires it. File and card identity remain stable during settlement.

## Alternatives considered

**Keep a warning in the header or detail surfaces.** A generic recording warning draws attention away from confirmed files without explaining an actionable consequence. Internal evidence already determines which restoration operations are safe.

**Display zero files after a failed capture.** Missing evidence cannot establish an empty change set. Hiding an empty card preserves this distinction without introducing another status surface.

## Consequences

The conversation gives more space to file content and keeps confirmed results readable. Unknown evidence stays distinct from a measured empty change set without another status surface. Backend checkpoint evidence, comparison states and restoration validation remain authoritative and unchanged. Browser regression coverage checks hidden empty results, preserved rows, absent recording notices, compact geometry, locale and theme changes, and reachable actions at narrow widths.
