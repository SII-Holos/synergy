# Decision Record: Native visual component catalog

Status: implemented

## Problem

HTML visual results wait for a completed tool call before execution. Common parameter-driven explanations require authored scripts and custom styling even when a small set of controls and metrics suffices. Recreating controls as content arrives loses local edits and focus.

## Decision

The existing `render` tool accepts either HTML or a bounded declarative `ui`. Util owns its portable schema, reference validation, ordered arithmetic and escaped static fallback. Shared UI draws ten known component types using text nodes and host-owned elements. There is no generated code evaluation or component-defined CSS in this path. Node and state keys retain control identity and local values across updates. Model output remains data even when drawn in the host document.

Validated partial tool input supplies a preview through the existing throttled tool renderer. Worker tool-input batches flush within 250 milliseconds while retaining their 32 KiB bound, event order and acknowledgement backpressure. Incomplete tails wait for more input; arithmetic failures retain the last successful view and report a diagnostic. Preview interactions stay local until the completed source is read through Media's ownership boundary. Completion saves those edits through the existing revisioned Part state. Conflicts adopt canonical state and invalidate queued edits. Follow-ups, expansion, close and export use the existing host confirmation and flush boundaries.

Sources add optional catalog data and a renderer discriminator to the existing format. Old sources require no rewrite; HTML and static history keep their execution policies. Descriptors omit both HTML and catalog content. Every native source contains a computed, escaped initial HTML fallback for static consumers. Fork and full export/import retain the immutable catalog along with its independently writable state.

Activity projection distinguishes a tool's visual card from its promoted attachments even when both reference the same Part. Reasoning visibility transitions retain their existing Part identity. The [timeline collision postmortem](../../../postmortem/0064-visual-card-attachment-identity.md) records the full-page regression and behavioral guard.

Standalone export runs the same host-authored catalog renderer and finite arithmetic over escaped JSON, retaining local controls while disabling host follow-ups. Runtime state automatically exposes current parameters through the existing per-model semantic context.

The catalog and keyed reconciliation are informed by [the Intelligent UI implementation analysis](https://www.openui.com/blog/how-chatgpt-intelligent-ui-works). Synergy uses schema-checked data and bounded arithmetic instead of DIL compilation and sandboxed generated JavaScript. The existing [visual state decision](2026-10-08-render-artifact-state.md) retains ownership of persistence and confirmed inputs.

## Alternatives considered

**Only extending HTML controls.** This retains full authored-program complexity and cannot execute incomplete programs safely during generation.

**Adopting DIL and its JavaScript compiler.** This introduces a language, compiler and untrusted program runtime for cases that a bounded catalog can express. Rich programs already have the existing HTML path.

**A new tool and state protocol.** This duplicates source, transfer, confirmation and recovery ownership rather than improving the current product surface.

## Consequences

The initial catalog covers headings, text, rows, cards, metrics, sliders, selects, checkboxes, bars and confirmed follow-up buttons. Arithmetic is intentionally finite and ordered; unsupported designs use HTML. Catalog and state byte limits bound validation and interaction costs. Native content follows host typography and theme without an iframe or source re-execution. This does not establish a token or latency improvement for real models; that requires a separate measured evaluation.
