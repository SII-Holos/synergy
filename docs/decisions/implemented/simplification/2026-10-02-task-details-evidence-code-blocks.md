# Decision Record: Task details evidence code blocks

Status: implemented

## Problem

Representation switches, field-directory navigation and multiple diagnostic tabs make users operate an inspector before they can read saved evidence. Unframed raw text lacks clear ownership, while a detached copy action does not identify which content it copies.

## Decision

Task details presents saved evidence as titled text or JSON code blocks, each with its own copy action. Tools have Result and Parameters and diagnostics views. Model calls retain saved request and response views, with actual retries linked when present; messages expose saved content directly. Timing and saved rates remain subordinate diagnostics. Search, download and wrapping belong to each large block's auxiliary menu.

The reader opens the complete saved field without a representation selector or field-directory prerequisite. Small complete JSON is indented for reading; copy and download retain the original recorded bytes. Large evidence continues to use bounded UTF-8 range loading, virtualization, version pinning, byte-count/checksum validation and cancellation. Saved raw tool output and the model observation remain separately labeled evidence.

The ownership, accounting, lifecycle and navigation decisions in [task details and execution trajectory](../feature/2026-10-01-task-details-execution-trajectory.md) remain applicable. Scope checks and evidence APIs do not change.

## Alternatives considered

**Retain the field directory and representation switch.** This preserves an explicit structural browser but requires choices before ordinary reading and duplicates the role of labeled content blocks. The section API remains available without controlling the default presentation.

**Load every full body into a plain code block.** This simplifies rendering but makes large evidence consume unbounded memory and loses cancellable range loading. Small and large blocks share presentation while retaining different bounded reading strategies.

## Consequences

The inspector has fewer permanent controls and copy ownership is visible. Structured exploration yields to direct evidence reading and full-object search. Large content retains internal scrolling and verified complete export, and partial evidence cannot be mistaken for a complete copied JSON object. Regression coverage includes local copy, default saved-field visibility, twenty-megabyte multibyte content, historical navigation and narrow-panel reading geometry.
