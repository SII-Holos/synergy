# Decision Record: Observe Workbench cancellation before releasing the fixture response

Status: implemented

## Problem

The real WebSocket presentation test sent a cancellation frame and then released a held resource response through the browser control channel. Those channels have independent delivery order. If resource resolution ran first, the client correctly applied the request before observing cancellation, while the test expected a cancelled or superseded result.

## Decision

Wait for the request's actual cancelled receipt while the resource response remains held. Then release the response and require that cancellation remains its terminal outcome and the previous resource stays visible. Assert exact cancelled versus superseded outcomes with the action identity included in failures.

The duplicate-request scenario also waits for the first resource read to reach its hold before releasing it. Production request handling, cancellation, transport delivery and resource commit rules remain unchanged.

## Alternatives considered

**Sleep after sending cancellation.** A fixed delay cannot establish remote processing and adds avoidable test latency.

**Accept an applied result.** This would stop testing cancellation of a request whose resource resolution is still pending.

**Change the product to defer commits.** The product cannot infer a cancellation it has not received; an extra delay would only move the race.

## Consequences

The fixture now orders its dependent actions using a protocol receipt. A controlled transport-delay diagnostic reproduces the prior applied outcome and passes once the receipt precedes response release; that diagnostic delay is not part of the committed test. Verification retains real browser/WebSocket integration, the original CI batch with randomized order, connection fencing, duplicate handling, history isolation and visible-resource checks.
