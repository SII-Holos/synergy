# Decision Record: Observe installed acceptance failures without changing execution

Status: implemented

## Problem

Released-upgrade acceptance creates historical data with a pinned executable before starting the candidate. A repeated filesystem effect during that initial phase cannot identify a candidate migration regression. The existing failure output did not distinguish a newly generated provider call from repeated execution of one call. Native Browser acceptance also had several asynchronous viewport and capture operations between progress markers; its outer deadline could hide the operation still pending or an error delayed by cleanup.

## Decision

The installed provider fixture retains request metadata: streaming mode, the selected task index, message roles, tool-output call IDs and the generated call ID. Released-upgrade acceptance prints those receipts on failure. It does not retain command text, message content, endpoints or credentials in that receipt. Each eligible request still generates its own call ID; the fixture never silently deduplicates a repeated command. A focused HTTP regression verifies both repeated generation without tool output and completion when the matching tool output is present.

The native page-pool fixture reports viewport waits, fixed/fit transitions, screenshots, page errors and cleanup boundaries. It records a local failure before cleanup can delay delivery to the parent. Production commands, capture assertions, effect counts and deadlines remain unchanged.

## Alternatives considered

**Accept multiple effects or deduplicate them inside the provider.** Either would hide replay and make the acceptance unable to reject a real repeated write.

**Increase deadlines or automatically retry the scenarios.** A passing retry would not identify which operation failed, and a longer parent wait could still hide the original error.

**Infer a candidate defect from the failed job or an environment failure from concurrent load.** Attribution requires the actual execution phase, input context and command completion. Unchanged source and a passing baseline narrow the investigation but do not prove either cause.

## Consequences

The next failure carries enough metadata to distinguish missing tool context from repeated execution and enough native progress to locate an interrupted asynchronous operation. Receipts are diagnostic evidence, not a substitute for successful candidate upgrade or native-platform acceptance. Runtime payloads, immutable historical binaries and product behavior are not patched speculatively.
