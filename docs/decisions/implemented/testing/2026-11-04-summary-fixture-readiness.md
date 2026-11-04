# Decision Record: Summary fixture readiness

Status: implemented

## Problem

The summary recovery fixture must distinguish a hung comparison from a later successful run. A short wall-clock deadline also covers history reads and storage writes, so a busy runner can time out the recovery run before comparison starts. That failure does not establish that the summary queue remained wedged.

The historical read-budget fixture inserts raw history without a summary cursor. Finishing a file-observed segment starts a detached summary, whose initial cursor construction reads historical bodies. Counting those first-time reads against the subsequent-read budget makes the result depend on background scheduling.

## Decision

The fixture captures the summary's configured timer callback through a scoped spy that forwards native timer creation. It invokes that callback only after the first comparison has entered its deliberately unresolved operation. Readiness races the summary's completion so early settlement or rejection remains visible. The test asserts the persisted timeout state, then requires another summary to execute and persist the expected diff under the normal framework deadline.

The historical read-budget fixture prepares its summary through the public summarization operation before observing subsequent reads. It settles detached work after segment completion and before checking the unchanged two-body budget and latest-root identity. Finite-page selection, metadata-only last-exchange updates and absence of binary reads remain asserted across every history size.

## Alternatives considered

**Increase a short wall-clock timeout.** This changes the probability of the race while preserving its dependency on runner load.

**Retry the failed test.** This can hide a queue recovery regression and does not control the timeout's ordering.

**Replace the global clock.** This would affect unrelated storage and runtime work. Matching the fixture's configured summary delay keeps the replacement limited to its owned operation.

**Relax the historical read budget or disable snapshot settlement.** Either would remove the bound that the fixture is meant to protect. Explicit initial preparation and detached settlement preserve real snapshot and summary behavior while measuring the intended phase.

## Consequences

The timeout test exercises the production abort and queue cleanup path without waiting for elapsed wall time. Native timer scheduling accuracy is outside this assertion; product deadlines and the test framework timeout remain unchanged. The scoped spy is restored when the fixture finishes.

The historical fixture pays for initial summary preparation and joins the detached work it starts. Its read-count guarantee covers subsequent operations, not initial cursor construction. Production initialization and scheduling remain unchanged.
