# Decision Record: Preserve formulas in selected text

Status: implemented

## Problem

Browser text selection flattens KaTeX's visual HTML and accessibility MathML together. Copying or quoting prose containing formulas duplicates symbols and introduces line breaks between individual characters. Removing repeated newlines cannot recover mathematical structure or distinguish a layout break from a paragraph boundary.

## Decision

The shared [selection serializer](../../../../packages/ui/src/components/clipboard-selection.ts), exported through the existing clipboard module, uses the renderer's trusted LaTeX annotations. Each selected formula becomes one inline `$…$` expression or one display expression enclosed by separate `$$` lines. Endpoints inside a formula expand to that complete formula on a cloned range, leaving the live selection and its direction intact. Prose retains paragraph and hard-break boundaries; table cells remain separated and code keeps its indentation.

The [selection toolbar](../../../../apps/web/src/components/text-selection/selection-toolbar.tsx) captures that text for Copy, Add to chat and plugin text actions. Its native copy listener applies the same plain-text conversion synchronously when selected math is present. Editors, excluded selections and already-handled copy events keep their owners. Button copying continues through the shared clipboard service, including its Desktop bridge and textarea fallback. Selections without trusted math use browser text unchanged.

The existing generated-math marker and annotation reader live in a [lightweight module](../../../../packages/ui/src/context/markdown-math-source.ts) shared by the parser, worker and selection serializer. Raw HTML cannot claim a trusted formula source. Reading selections does not import the parser or KaTeX runtime.

## Alternatives considered

**Remove line breaks from browser selection text.** This leaves duplicated visual and accessibility output and would also merge real paragraphs or damage code indentation.

**Suppress MathML during rendering.** This reduces accessibility while still leaving the visual formula's layout spans unsuitable as a text representation.

**Install the generic KaTeX copy handler.** Its source-extraction approach is useful, but a standalone native-copy handler would not cover the toolbar's captured text or quoted passages, and does not own Synergy's generated-source trust checks or prose boundaries.

## Consequences

Mixed prose and formulas produce reusable plain text with explicit LaTeX rather than a visual approximation. Partial formula selections intentionally include the entire formula. Math selections use plain-text clipboard output; rich document formatting is outside this change. Existing whole-message source copying and direct formula copying retain their owners.

Real-browser regressions cover toolbar copy, quotes, keyboard copy, selection stability, editor/exclusion ownership and late action completion. Focused serializer tests cover formula endpoints, paragraph boundaries, tables, code whitespace and forged annotations; existing renderer and worker tests retain their coverage of source ownership.
