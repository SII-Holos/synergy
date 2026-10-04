# Decision Record: Versioned file review with a continuous diff surface

Status: implemented

## Problem

Review must remain readable across many files, long paths, narrow panes and incomplete recording. Compact history summaries can omit patches, so treating summary rows as complete content leaves valid changes invisible. Comparison, current-file navigation and restoration require different file authorities. Comments and exported patches must remain tied to their original versions when files or workspace bindings change.

## Decision

The Web Review panel offers turn, session, uncommitted workspace and explicit Git reference comparisons through one compact toolbar and continuous virtualized diff surface. Historical content comes from retained session snapshots. Git comparisons use read-only workspace operations with generation and version checks. Captured before/after contents support source and sanitized previews; current-file navigation requires the matching active workspace binding.

The viewer owns sticky file headers, line selection and bounded syntax highlighting. Its 24px line metrics and fixed 44px headers match the rendered CSS; pending, failed and folded-import indicators stay inline so loading cannot shift navigation targets. Automatic layout follows the available diff width; navigation moves into a file picker in narrow panes. File actions reveal on hover or keyboard focus and remain available on touch surfaces. Display settings alter projections only. Static import folding parses declarations and retains original line numbers. Export reads canonical binary-capable patches rather than reconstructing displayed or folded content.

Session review state stores version-bound viewed markers and comments with their original excerpts. Revision-checked writes prevent lost edits. Selected comments require an editable handoff preview before input admission. Historical restoration retains its existing preview, confirmation, version and idempotency checks; Git comparisons have no mutation controls.

File reads run through a cancellation-aware four-slot queue. Contents and projection caches are bounded and released on comparison identity changes. Transport errors produce an explicit retry state, and recording states remain separate from empty comparison results.

## Alternatives considered

**Extend the independent per-file accordion.** It preserves existing restoration integration but creates excessive mounted renderers and repeated controls for large comparisons. It remains suitable for individual captured tool results; the main Review surface uses one virtualized viewer.

**Reconstruct exported patches from the visible diff.** This would lose hidden context, binary data and original import ranges. Export uses the canonical backend patch, and files exceeding content limits report that export is unavailable.

**Use current files for historical previews.** It would silently replace the reviewed version after subsequent edits. Retained snapshot ownership governs historical reads, including missing files and binary versions.

## Consequences

The panel gains consistent comparison, navigation, preview, annotation and export behavior without changing restoration authority. Separate historical and Git read paths add API and testing responsibilities. Preview size limits, a 5,000-file Git comparison limit and bounded caches make resource use explicit; unsupported workspace storage and oversized files report local failures. Arbitrary Git filenames are accepted by read-only review validation, while workspace transfer and restoration retain their stricter path policy.

The rendering implementation consumes the existing [Pierre diffs](https://github.com/pierrecomputer/diffs) viewer and the [Babel parser](https://babeljs.io/docs/babel-parser) for static declarations. A pinned [Kobalte focus patch](../../../../patches/README.md) handles pending iframe documents and visibility across frame windows; its browser regression covers loading and native keyboard traversal. The product reference is [File review](../../../reference/file-review.md).
