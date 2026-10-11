# Decision Record: Single-session context dashboard

Status: implemented

## Problem

Task details needs to explain what occupies a model request, how it changes and which recorded sources contributed. Aggregate metrics and execution records alone require too much navigation, while a large composition graphic without category values consumes the reading area. Historical estimates and provider totals also need distinct meanings.

## Decision

The existing context panel owns one dashboard and request selection across sidebar, Workspace fullscreen and execution-record drilldown. Cards separate cumulative Token and timing statistics, the latest request context, request trends, the source browser and task activity. Wide layouts pair statistics cards above current context and trends, with the browser alongside both, with the same mounted components reflowing into a narrow reading order. Each card reflows its legend against its own width so two-column layouts retain readable category names. Cumulative components never double-count cache or reasoning subtotals. Hover temporarily previews a request in the chart detail and browser, then restores the clicked selection; it never recolors other historical bars or replaces the latest-context summary. Incoming updates preserve committed selection and keyboard focus. Retained/latest references are replaced when `callID` changes and reconciled only for updates to the same request; changing selection must never morph a shared historical entity. Controller tests exercise repeated selection and new latest events as well as chart rendering. Source changes compare adjacent estimated contributions, so provider reconciliation alone does not imply added content. Request titles name the selected request directly. Shared theme Tokens, semantic controls and reversible disclosure motion govern presentation. Category rows own the disclosure chevron; compact source rows use an explicit reading action and reveal one copyable evidence block. Asynchronous body height changes and quick reversals use the same motion controller. Task activity owns the single complete-records entry; requests, tool counts and failures open specific records or filters. Records inherit their entry scope without a second selector or repeated metrics. Inspector filter status retains the last confirmed result for the selected owner while list ordering reloads; pending, failed or superseded pages cannot turn a temporary absence into an exclusion notice. The dashboard owns saved navigation and merges record state without losing its selected request or reading position. The retired overview and activity dialog are removed, while shared cost presentation remains independently reusable. A bounded list and inspector use the same card surfaces; narrow layouts replace the list with its selected evidence document. Model inspection presents metadata, request, response and timing in one scrolling document, eliminating repeated source links and tab navigation. The selected record mounts bounded body readers independently so slow evidence does not block metadata; full bodies remain paged and leaving cancels both readers. Copy and download preserve evidence format and checksum, including newline-delimited provider responses. Returning restores dashboard focus and scroll, including after diagnostic filtering or viewport changes.

Harness records eight provenance categories in ContextUsageV2 without increasing the total asynchronous estimator sampling budget. Provider input remains authoritative and residual input remains unattributed. Request evidence stores body content once alongside a metadata-only source index. The owner migration retains older attribution as named historical aggregates and never fills missing snapshots. Workbench supplies paginated, read-only SDK operations and enriches the existing execution revision stream. The runtime has one current schema and rendering path.

## Alternatives considered

**Keep aggregate categories and improve only the surface.** This leaves skill, runtime and user contributions indistinguishable and cannot explain individual sources.

**Infer sources from text or paths in the frontend.** This guesses ownership after request transforms and can double-count skill results. Provenance is resolved where the final request is constructed.

**Mount an independent expanded view.** This duplicates selection, readers and animations and loses continuity. Workspace fullscreen retains the same instance.

**Load full prompt history for browsing.** This gives immediate body access at unbounded cost. Metadata pages and versioned body chunks preserve the evidence cache budgets instead.

## Consequences

The dashboard exposes more useful information in the first viewport while retaining diagnostics and exact usage detail. Attribution remains an estimate, older snapshots remain coarse, and binary input costs can remain unattributed. Timing phases describe recorded cumulative durations rather than inventing separate reasoning or parallel wall-time accounting. Bounded history and content windows require explicit loading for older or larger evidence. Behavioral coverage includes migration/import idempotence, request provenance, pagination, event races, focus preservation and aborted reader recovery; production visual checks complement these tests.
