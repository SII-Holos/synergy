# Decision Record: Settings frontend optimization

Status: implemented

## Problem

Settings mixed preference drafts, immediate commands and raw configuration details in a long, inconsistent interface. Voice configuration had no independent enable state or durable clearing semantics. Failed refreshes could hide completed writes, and page disposal could lose staged values or active audio cleanup.

## Decision

Apply one Settings shell and shared preference, resource, flow and advanced-section primitives across built-in and plugin pages. Keep registered section IDs, capability filtering, developer visibility and plugin APIs stable. General has local subviews; service discovery is separate from connected accounts; the primary model remains prominent while specialist roles stay available in advanced assignments. Scope typography, spacing and motion to Settings and resolve all colors through public theme tokens.

Keep preference controllers in the panel owner, including the Boss name stored in self-memory. Blur and page disposal retain these drafts without writing. Numeric and structured-text validation runs before patch normalization, and search indexing shares the field descriptors rendered by each page. Save validates every dirty source, reconciles each successful domain against the submitted snapshot and retains failed or newer drafts. A completed write leaves a receipt until its read succeeds; retries reconcile that receipt before submitting further changes. Connection and account commands use the same write/read distinction. Appearance choices retain their immediate behavior.

This refines the draft recovery contract in [Settings recovery](../bug-fix/2026-09-25-preserve-settings-section-and-draft-recovery.md) and extends the saved speech configuration in [Voice modality](2026-09-04-voice-modality-stt-dictation-tts-tool.md). Audio call artifacts follow the canonical media call recorder.

Media owns optional speech enable switches, persisted nullable clears and credential redaction/restoration. An omitted enable switch preserves legacy model-based behavior without rewriting files. Changing a speech model writes the current enable intent so a first model does not implicitly enable the capability. Saved-config recording tests reuse the dictation pipeline, and `voice.preview` calls the canonical speech service without allocating a task session. UI disposal cancels pending calls and releases microphone tracks and temporary audio URLs.

Settings controls use the public inset surface and readable body/error text without changing workbench input colors. Rows switch between columns and stacked controls based on the content measure, keeping short switches compact. Navigation omits developer and save badges; General owns the immediate local developer visibility preference. The footer retains per-source validation, write and refresh outcomes, and re-reading completed writes does not repeat commands.

Wide selectors reserve the trailing edge for their chevron while keeping values left aligned. Settings triggers use borderless inset fills with a separate keyboard focus ring. Floating menus keep their boundary and shadow, reserve a trailing check for the selected value and use a light fill for hover or keyboard navigation. Voice templates and declarative plugin enums share the menu field instead of platform-dependent native option lists; the Settings owner supplies their portal layer. Configuration-file disclosures use one padded detail surface, monospace paths and content-based wrapping without nested fills. Both session scopes resolve permission names through the same profile descriptors. Menu Escape handling preserves single and multiple selections while returning focus to the owning trigger.

Configuration completeness and runtime health are distinct. Channel setup links to the owning configuration domain, email separates sending and reading tasks, and Formatter/LSP queries belong to an explicitly selected project. Disabled speech shows configuration intent without implicitly enabling a service. Advanced regions retain exact parameters and diagnostics while search opens only the relevant region.

The bulk usage query omits services without a reader. Settings queries omitted connected accounts individually, preserves independent failures and uses the existing snapshot source field to distinguish unsupported queries from failed queries. Radio inputs stay positioned inside their own option so keyboard focus scrolls the content rather than the fixed dialog shell. Mobile footer columns retain their layout when status text wraps.

## Alternatives considered

**Independent per-page save buttons.** These keep local implementations small but make cross-page drafts and partial failures hard to explain. A shared footer makes the explicit commit boundary visible and retains page ownership in failure reporting.

**Saving automatically before tests and connection actions.** This makes actions convenient but commits preferences implicitly. Tests and operations remain separate, and actions that depend on changed settings require the footer save first.

**Deleting models to disable speech, or omitting empty optional fields.** Both lose user intent: disabling destroys configuration, while omission retains the previous override. Independent enable switches and durable null values distinguish retention, disablement and clearing.

**Replaying a write after refresh failure.** This simplifies retry state but can create duplicate accounts or repeat credential commands. Retaining the acknowledged write result permits a read-only retry.

## Consequences

Settings controllers and command receipts have explicit reconciliation state. The media schema and generated SDK carry compatible optional fields and one additional binary endpoint. Behavioral tests cover drafts, partial writes, refresh retry, credentials, role intent, nested dismissal, field labels, focus return and audio disposal; responsive verification covers desktop and narrow layouts. Real speech calls require credentials for an audio-capable service and remain separate from isolated fixture verification.
