# Decision Record: Append semantic context updates at source granularity

Status: implemented

## Problem

Comparing rendered advisory snapshots treats a changed retrieval selection, a pending cache refresh and live progress telemetry as changes to knowledge. Appending each changed snapshot preserves request prefixes but repeats unchanged memory bodies and creates avoidable state transitions. Removing old history would discard evidence and rewrite cacheable prefixes.

## Decision

Retain append-only advisory history and distinguish state, immutable knowledge definitions and occurrence events. Library supplies complete per-entry content and a separate stable selection of entry versions. Content revisions exclude retrieval scores and ranking. A definition is reusable only while verified in the effective context for the same scope; missing definitions are rehydrated after compaction or projection changes. Existing snapshots remain intact until ordinary history management removes them.

Pending Git refreshes retain prior evidence without claiming a fresh scan. Successful changed reports, confirmed resolutions and actual observation failures produce state updates. Invalidation fences in-flight scans, including repository aliases; a timeout or failed command cannot become an empty successful report. Cortex contributes per-task decision information while detailed telemetry remains in progress interfaces. Time observations describe input arrival and commit once with their task-root marker.

Format v2 records semantic kinds and source-block hashes/ranges. A session-owned migration upgrades v1 metadata while preserving stored text, its content hash and unknown fields on metadata and source entries. Access, import and explicit owner upgrades share that transform. Valid blocks remain reusable after an unrelated projected block changes; a repaired later observation supersedes invalid state evidence. Context usage attributes verified blocks to their source without changing model messages.

## Alternatives considered

**Rate limits or a fixed observation count.** These can delay real faults or discard evidence and do not address the unit of memory change.

**A permanent set of sent hashes.** This can reference knowledge absent from the active context and suppress necessary state restoration.

**Replacing old snapshots or rewriting old memory blocks.** This shrinks existing history but changes request prefixes and historical evidence.

**Shortening always memory or recalling on every tool step.** Neither is required to fix duplicate injection; both change independent Library behavior.

## Consequences

New context growth follows knowledge changes and decision-relevant observations. Knowledge bodies remain complete, while selection updates add identifiers and versions. Initial structured definitions carry some additional framing, so savings depend on actual changes and subsequent requests. Existing duplicate snapshots remain until compaction. Other provider snapshot layouts retain their existing behavior.

Regression checks cover retained definitions, source repair, unavailable observations, real Git invalidation, source attribution, durable reopen/fork/import, and exact SDK request prefixes through Session continuations. Live evaluation must additionally compare provider-reported cache reads, uncached input, total context and task correctness under the same model settings; deterministic prefix equality alone is not evidence of a remote cache hit. Private runtime data and evaluation artifacts remain outside the repository.
