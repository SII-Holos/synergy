# Decision Record: Content-first inline Render visuals

Status: implemented

## Problem

A model-generated visual is part of an answer, but a generic tool disclosure makes the reader inspect execution chrome before seeing it. Fixed minimum sizing wastes conversation space for short content, while rebuilding the iframe on theme changes discards native disclosure and scroll state. A larger visual also needs a readable view without moving the reader into a separate workspace.

## Decision

The completed `render` tool with non-empty HTML uses a dedicated [RenderTool](../../../../packages/ui/src/components/render-tool.tsx) figure at its canonical conversation position. The content appears first, followed by a quiet title and an accessible expand action. Pending, running, failed and missing-content receipts retain the generic lifecycle presentation. The App's summary-level [row projection](../../../../apps/web/src/components/session/conversation-rows.ts) excludes Render from process chunks and activity groups using the shared tool classification; Render remains visible when process history closes. Final-answer prose before a Render result is not execution prose merely because a tool follows it. No backend schema or persisted message changes are required.

The generic active-state presentation in this decision is replaced by [Inline Render preparation](../bug-fix/2026-10-05-inline-render-preparation.md); the completed visual, isolation and viewer decisions below remain authoritative.

[RenderHtml](../../../../packages/ui/src/components/render-html.tsx) measures natural body content, allows shrinkage after content or width changes, and caps the inline tool at 480px. A single fullbleed root removes body padding. The expanded view captures the selected content, mounts a second iframe only while open, and uses the shared Dialog stack for dismissal and focus return. Escape inside the iframe closes its own viewer. Theme and font events update the host-owned style in the current document rather than replace `srcdoc`.

HTML remains static and self-contained. DOMPurify parses a whole document with an initial no-network policy; the host prepends its CSP to the actual sanitized head, removes HTML, SVG and MathML navigation attributes and animated SVG navigation, and retains only local SVG `use` references. The iframe keeps `sandbox="allow-same-origin"` without scripts so the host can measure and update it. Host listeners prevent navigation without suppressing native disclosures inside MathML integration content and are released with the document. This is distinct from the script-capable [workspace HTML preview](2026-09-01-workspace-html-preview-default.md).

The presentation borrows content-first conversation visuals from Claude Custom visuals; the external source and local adaptation are recorded beside `RenderTool`. It does not assume standalone Codex or Claude Code has an equivalent native feature.

## Alternatives considered

**Keep the generic expanded tool card.** This preserves execution metadata but repeats chrome around answer content and does not solve natural sizing or focused reading.

**Move every visual into an Artifacts-style side workspace.** This is useful for editable applications, but a read-only table or diagram should not require leaving the narrative. The shared viewer supplies additional space on demand.

**Enable scripts or an MCP application bridge.** Interactive applications require separate permissions, lifecycle and communication semantics. They are outside this static render improvement and would weaken the existing trust guarantees.

**Use only sandbox and a regex-injected CSP.** A no-script sandbox does not forbid iframe self-navigation, and a misleading or malformed head can place a regex-injected policy outside the real document head. Structural sanitization and an actual host-owned first policy avoid both assumptions.

**Reload the document for every theme change.** This is simpler but loses native disclosure and scroll state. Updating one owned style retains the live document.

## Consequences

Short visuals occupy their natural height and remain in the answer's original part order. Large results have a bounded inline region and an on-demand accessible viewer; the expanded iframe does not share transient disclosure state with the inline copy. Same-mode themes and font changes repaint without resetting the current document.

Authored links, forms, refresh directives, scripts and animated SVG are intentionally not actionable. Inline CSS, static SVG and native details remain available. DOM sanitization adds work when HTML changes, but not for theme events. Regression coverage uses summary-level row projection, the real SessionTurn, tool registration and production styles, with Chromium checks for loading-time theme updates, resizing, fullbleed fragments with separate styles, retained native interactions, fallback wrapping, keyboard dismissal, narrow layouts and blocked resource/navigation requests.

The Chromium fixture exercises the actual RenderTool through SessionTurn. Its exact file is registered in the coverage exemption manifest because Vite-rendered TSX does not contribute to Bun lcov; package coverage thresholds remain unchanged.
