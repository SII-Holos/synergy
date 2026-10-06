# Decision Record: Group continuous reasoning item fragments

Status: implemented

## Problem

A provider reasoning item can emit several summary fragments with distinct stream IDs. Rendering every saved Part as a separate disclosure duplicates the Reasoning entrance for one item. Grouping only mounted Parts also repeats the entrance when a continuous item crosses a virtual body chunk.

## Decision

[Reasoning identity](../../../../packages/util/src/reasoning-item.ts) derives a bounded key from one provider namespace and item ID. Part summaries carry this optional key without encrypted provider content. Continuous visible reasoning fragments within one assistant message share the first Part's disclosure key. Tools, prose, another item and missing identity preserve independent entrances.

The Web summary projection establishes anchors before body hydration. Body chunks keep their six-Part and 128 KiB budgets, render only their own text and share expansion state. Only the leading chunk renders the trigger; detail regions retain distinct IDs. Fragment paragraphs use the same 8px flow gap within and across chunks, while canonical chronology remains intact. Each fragment retains its own Part target for reading; another fragment loading or growing cannot replace it with the chunk entrance. A removed fragment falls back to its shared leading trigger and that trigger's actual virtual row. Disclosure changes retain the process and outer reading anchors. Whitespace-only reasoning is excluded from the visible summary projection.

The owning Session identity migration depends on the empty-reasoning display migration and uses the same batched metadata invalidator for the admitted owner and late imports. Repeated invalidation is idempotent. Bounded reads rebuild summaries lazily. Raw stream IDs, saved Parts, encrypted context and rollout evidence are preserved.

## Alternatives considered

**Merge fragments in the stream processor.** This changes saved Part identity and context reconstruction despite correct provider event handling. Presentation grouping solves the duplicate entrance while preserving original evidence.

**Group only the mounted body chunk.** This leaves repeated triggers at render-budget boundaries and loses a shared expansion preference when fragments arrive in another chunk.

**Group every occurrence of the item ID.** This can join different provider namespaces or reasoning separated by tools and public prose, obscuring the original chronology.

## Consequences

One reasoning item has one stable entrance through streaming growth and virtual rendering. The optional summary field requires generated client updates and lazy historical index invalidation. Histories without trustworthy item identity retain separate disclosures. Regression tests cover identity ambiguity, paragraph order, tool/prose boundaries, bounded chunks, keyboard focus, expansion preference and canonical-content preservation. The current projection rules live in [sessions and messages](../../../architecture/session-and-messages.md#activity-presentation) and [frontend data sync](../../../architecture/frontend-data-sync.md#demand-driven-resources-and-content).
