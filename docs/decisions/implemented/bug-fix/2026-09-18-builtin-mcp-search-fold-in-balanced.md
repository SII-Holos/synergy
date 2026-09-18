# Decision Record: Fold built-in MCP search cards into balanced activity groups

Status: implemented

## Problem

[Built-in anysearch/scholight MCP servers replace first-party web/arxiv search tools](../feature/2026-09-03-builtin-search-mcp-replace-first-party-tools.md) exempted `mcp__anysearch__*` and `mcp__scholight__*` from activity folding by treating the prefixes as presentation boundaries in `isActivityGroupableTool`. That shared check served two consumers: the server-side activity summary and the Web balanced timeline. [Remove background activity summaries](../simplification/2026-09-08-remove-background-activity-summaries.md) deleted the server-side summary, so the prefix rule's only live consumer became the Web timeline itself — with the result that balanced mode rendered these cards exactly like full mode and never compacted the two highest-frequency search families, defeating balanced display for its most common workload.

## Decision

- Remove the `ACTIVITY_PRESENTATION_BOUNDARY_PREFIXES` rule from `packages/util/src/activity.ts`; `isActivityGroupableTool` keeps only the `render` presentation boundary plus the metadata-driven `toolCard: hidden` and `media-generation` exclusions.
- Classify the six built-in MCP search tool ids (`mcp__anysearch__search`/`batch_search`/`extract`/`get_sub_domains`, `mcp__scholight__search_papers`/`extract_url`) as `web` in `TOOL_CATEGORIES`, so folded steps land in the `research-web` family group instead of depending on input-based fallback classification.
- Resolve Scholight step titles, icons, queries, and URLs through the existing tool-info helper so folded rows retain their search context.
- Balanced and minimal projections fold these cards like every other ordinary tool; full mode and expanded group details still reach the per-query card renderers through the existing tool registry.

## Alternatives considered

- **Keep the exemption and render custom cards inside balanced group rows** — rejected: group rows render projected step summaries, not per-tool custom cards; mounting the `batch_search` and `search_papers` card layouts inside a group row would fork the two presentation models and complicate row height and state handling for every other family.
- **Keep the exemption for `batch_search` only** — rejected: the per-query-structure argument applied to the whole family, and after the summary consumer's removal no consumer distinguishes the two; a partial exemption recreates the same "balanced looks like full" inconsistency within one family.
- **Reintroduce a server-side summary consumer that consumes the boundary** — rejected: the summary removal decision stands because balanced rows do not display generated group summaries and auxiliary model calls could interrupt the owning task; recreating the consumer to justify a presentation rule inverts the dependency.

## Consequences

- Balanced mode compacts anysearch/scholight calls into `research-web` group rows like every other tool family; the information cost is one extra click to expand group details, which still expose the per-step rows.
- Every MCP family now folds by the same ordinary-tool rule, restoring the invariant the original decision kept for user-configured servers.
- The web classification keeps the folded group's family label and icon consistent with `webfetch`; custom search cards remain available in full mode and inside expanded group details.
