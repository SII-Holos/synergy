# Decision Record: Keep installed acceptance failures attributable

Status: implemented

## Problem

Released-upgrade acceptance creates historical data with a pinned executable before starting the candidate. A repeated filesystem effect during that initial phase cannot identify a candidate migration regression. The existing failure output did not distinguish a newly generated provider call from repeated execution of one call. Native Browser acceptance also had several asynchronous viewport and capture operations between progress markers; its outer deadline could hide the operation still pending or an error delayed by cleanup.

## Decision

The installed provider fixture retains request metadata: streaming mode, the selected task index, message roles, tool-output call IDs and the generated call ID. Released-upgrade acceptance prints those receipts on failure. It does not retain command text, message content, endpoints or credentials in that receipt. Each eligible request still generates its own call ID; the fixture never silently deduplicates a repeated command. A focused HTTP regression verifies both repeated generation without tool output and completion when the matching tool output is present.

The pinned 3.0.22 baseline and restored-backup phases copy the input file and append the non-idempotent effect without printing the copied contents. That removes the final stdout-triggered metadata flush implicated by the historical [terminal settlement race fixed in #1374](../bug-fix/2026-09-10-serialize-tool-settlement-behind-per-call-state-writes.md). Candidate and candidate-restart phases retain the stdout command and current processor regression coverage. Every legacy prompt must produce exactly one new provider tool call and one completed persisted tool with exit zero; all exact effect counts, copied bytes, migration history, plugin, attachment and restore assertions remain required. A real shell regression proves both commands retain every append across repeated execution and that only the candidate form emits stdout. No provider retry is hidden and the immutable executable is untouched.

This fixture choice does not repair the historical runtime or prove it free of all metadata races: its initial empty Bash metadata write is also asynchronous. Native acceptance and strict terminal-state assertions continue to expose that remaining risk. The source and receipt evidence identify the final-output ordering defect; the original failed runtime's full write ordering was not retained, so the diagnosis does not claim a recovered trace of that exact write sequence.

The native page-pool fixture reports viewport waits, fixed/fit transitions, screenshots, page errors and cleanup boundaries. It records a local failure before cleanup can delay delivery to the parent. Production commands, capture assertions, effect counts and deadlines remain unchanged.

## Alternatives considered

**Accept multiple effects or deduplicate them inside the provider.** Either would hide replay and make the acceptance unable to reject a real repeated write.

**Increase deadlines or automatically retry the scenarios.** A passing retry would not identify which operation failed, and a longer parent wait could still hide the original error.

**Infer a candidate defect from the failed job or an environment failure from concurrent load.** Attribution requires the actual execution phase, input context and command completion. Unchanged source and a passing baseline narrow the investigation but do not prove either cause.

## Consequences

The next failure carries enough metadata to distinguish missing tool context from repeated execution and enough native progress to locate an interrupted asynchronous operation. Historical fixture inputs isolate migration acceptance from the identified old output trigger while current-runtime output coverage remains active. Receipts and shell controls are not substitutes for successful candidate upgrade or native-platform acceptance. Immutable historical binaries and product behavior are unchanged.
