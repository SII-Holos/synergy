# Decision Record: Unified execution result presentation

Status: implemented

## Problem

Agent delivery details render a Cortex summary as one Markdown document. The generated execution preamble precedes the report and repeats part of it as a flattened quotation. A report starting with a heading turns that quotation into a large heading, while ordinary tool details use a separate result view and labeled output controls.

## Decision

Tools, agent deliveries and compaction share the App-owned detail layout, heading, keyboard tabs and recoverable loading state. A failed refresh preserves accepted evidence only for the same server, Scope, session, message and invocation. Compaction uses the shared UI presentation resolver; its recorded duration appears in the header while failure details and mechanical-summary limitations live in Diagnostics.

Agent details open the report first, with task identity, recorded status and duration in the existing execution-detail header. Recognized Cortex summary output separates the report from an execution-process tab. That tab retains the recorded preamble as plain text and exposes the complete original output in a disclosure. Result and process copy controls copy only their named content. Structured output uses the shared JSON evidence block.

The App projects the existing summary text only when its generated heading, statistics and phase preamble match. It consumes the generator's first report delimiter and preserves subsequent report separators and code. Final responses and unrecognized summaries remain verbatim. The projection changes no persisted messages, task ownership, notification acknowledgement or API schema. Captured task output and matching child metadata retain their existing identity checks.

Full `task_output` reads reuse the agent report component only when native input and returned metadata identify the same task and full-output mode. Retrieval status remains distinct from task status. Original receipts remain available alongside native input. Progress, tail, list and unknown outputs keep their evidence representation. Dedicated Diff, media and plugin results precede a collapsed raw-output disclosure. Server truncation is different from the local rendering preview: truncated evidence labels both expansion and copy as operating on the loaded portion. This change does not add a full-output retrieval API.

The trajectory producer emits each report once and separates statistics from phases with a paragraph break. Report typography is scoped to execution details; conversation Markdown keeps its existing styles. Browser regression coverage mounts the production Markdown renderer in a built fixture.

## Alternatives considered

**Render every result as raw text.** This provides uniform geometry but leaves report headings, lists and links unreadable as document structure. Raw evidence remains available in the process view.

**Change all shared Markdown styles.** Global styling would affect unrelated conversations and documents while retaining duplicated content and the wrong reading order.

**Replace the persisted output schema.** Structured presentation fields would require a broader storage and SDK change. The existing generated summary has a bounded, identifiable preamble, so a conservative read-only projection also improves historical results without rewriting them.

## Consequences

The result view prioritizes the delivered report and keeps diagnostic evidence accessible. The App's summary projection depends on the trajectory producer's format; tests cover both its historical single-newline phase boundary and its current paragraph boundary. Unknown formats stay readable without speculative splitting. The real Markdown browser fixture costs more preparation than a text substitute but covers heading and quotation regressions the substitute cannot detect.
