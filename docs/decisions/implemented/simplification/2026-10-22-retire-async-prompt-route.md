# Decision Record: Retire the async prompt route

Status: implemented

## Problem

`POST /session/{sessionID}/prompt_async` was a second HTTP entry point for the same admission step that `POST /session/{sessionID}/input` performs. Both validated `InvokeInput` and called `submitInput`, so the pair differed only in what the caller learned: the async route read the accepted Inbox item and threw it away, answering `204` with no body, while `input` returns the `SessionInbox.InputResult` that carries the admission `status`, the durable `item`, and the `runID` of a resumed task.

That removed information is the part callers need. A queued input is not a started turn: it can steer an existing run, start a new task, or wait for a save that failed, and the caller cannot tell which from a `204`. Nothing in the repository still needed the empty acknowledgement — every in-repo caller was migrated to the richer response, and the route was reachable only by an external client that had chosen the older name.

Keeping both also keeps two admission descriptions true at once. The durable-admission guarantee in [Session and messages](../../../architecture/session-and-messages.md) had to name both routes, and the admission test enumerated both endpoints to assert the same invariant twice.

## Decision

The route is deleted rather than deprecated. `/session/{sessionID}/input` is the only HTTP entry that persists input before scheduling it, and `session.input` is the only operation in the generated OpenAPI document, SDK types, and SDK client.

Admission semantics do not change: a caller-supplied message ID still identifies one input, durable Inbox admission still completes before the response, and the response status still distinguishes `started` from `queued`. Only the acknowledgement shape is retired, and the surviving shape is the strictly richer one.

The three repository callers move to the surviving route with the same request body: the memory-benchmark driver enqueues through `/session/{sessionID}/input` and tracks `session.input` as its native path, and the two Web workbench verification fixtures call `client.session.input`. The admission test now asserts the invariant once, for `input`, expecting the `200` that carries the result body.

## Alternatives considered

**Deprecate the route and keep it returning `204`.** A deprecation window would protect an out-of-repo client that calls the older name. Rejected because the route is a thin alias over the same `submitInput`, so keeping it costs a permanently doubled contract — two operation IDs, two response shapes, two admission sentences in the architecture document — to preserve the weaker half. A client that still calls it fails loudly on the first request, with a `404` naming the path, rather than silently receiving an acknowledgement that says nothing about what happened to its input.

**Make the async route return the `InputResult` body and delete `input` instead.** This would keep the older name and gain the missing information. Rejected because the name then misdescribes the contract: the response waits for durable storage, so `prompt_async` would promise immediacy the runtime does not provide. `input` names the operation without claiming a timing the implementation contradicts.

**Leave both routes and let callers choose.** Rejected because a second admission path is not free: `submitInput` owns lock ordering, pause handling, and the new-task-versus-steer decision, and a second route in front of it invites fixing one surface and forgetting the other. The repository already removed the duplicated take-back path for the same reason — see [Release the pause when a user restarts a loop](../bug-fix/2026-10-22-release-pause-when-a-user-restarts-a-loop.md).

## Consequences

One HTTP surface, one operation ID, and one admission description remain. The generated OpenAPI document, SDK types and SDK client each lose the route, and `packages/sdk` is regenerated from the route table rather than edited.

An external client that calls `/session/{sessionID}/prompt_async` now fails with `404` instead of receiving `204`. That failure is the intended signal: the request body it already sends is accepted unchanged by `/session/{sessionID}/input`, which is the migration path.

Callers that used the empty `204` as a fire-and-forget acknowledgement now receive a body. That body is additive for them — the request is still accepted before any model turn starts — but a caller that asserted on the empty response must accept the JSON result instead.
