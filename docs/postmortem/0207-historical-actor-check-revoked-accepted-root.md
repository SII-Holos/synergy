# Historical actor checking revoked an accepted root

## Executive summary

A shared Hosted task failed after its creator left and a current collaborator answered the task's question. Its next resource description required the historical input actor to remain active despite the original Runtime still owning the accepted root. Keep input attribution separate from canonical native acceptance and current Runtime authority, while retaining fresh authorization for released-generation reacquisition and API tokens.

## Summary

The real model-backed question case reached the original Asked event, creator removal and the authorized collaborator reply. The native task then failed instead of continuing with its existing resource selection. Its persisted safe error was `OrganizationRuntimeError: The original execution actor is no longer active`. This was a failed execution with complete recording, not an unobserved completion or a readiness timeout.

## Timeline

- Event-based readiness exposed the original Asked event without repeated HTTP polling. The existing question case reached nine assertions before reporting the failed native execution.
- The original failure diagnostic confirmed a failed Run and execution, no remaining background work, the original binding intact and the explicit historical-actor error.
- Tracing the Service resource owner found that signed acceptance reconciliation and current Runtime checks succeeded before a common execution check independently required the historical human account.
- The original Service semantic controls produced two failures, two passes and 28 assertions. A separate positive archived-project binding control failed under the original source after ten assertions.
- The correction passed both Organization and Organization Runtime typechecks. The canonical complete `execution-grants.test.ts` and `execution-actor.test.ts` batch passed 18 tests and 178 assertions, including archived-project binding, rejected fresh input, budgets, exact identity, held work, delayed B, actual Runtime-owner removal, released reacquisition and API authority.
- The original inspection suite separately passed eight tests and 70 assertions, and retention separately passed two tests and 11 assertions on the same corrected production source. These are distinct complete file results, not a claim that all four files passed together in one invocation.
- The complete original Hosted question case passed with 37 assertions through natural completion; the original native execution case separately passed with 21 assertions, including derived-call drainage and resource release.
- Complete canonical verification and CI are not green. A separate original bridge observation recorded Service close code 4008 after a 391 ms heartbeat gap exceeded the fixture's 300 ms offline interval, followed by command-admission unavailability. The test-fixture clock correction and its validation belong to a separate owner; these observations do not revoke the accepted role-fix results.

## Root cause

The execution-grant owner used one global historical-account check for both already accepted, held interactive work and fresh reacquisition. Public description and binding already verify the current registered machine and connection, reconcile the exact signed B receipt with canonical Service acceptance, and resolve the original actor/root/grant/Session identities. Rechecking the historical human account at that point incorrectly revoked another valid Runtime's accepted work. Merely removing the check for every grant would create a different defect: a released generation could reacquire resources without current actor authority.

## Guardrails

- [x] Machine check: the original `packages/organization-runtime/test/hosted-permission-boundaries.test.ts` case reproduced the failed native execution after nine assertions with the exact historical-actor error.
- [x] Machine check: `packages/organization/test/execution-grants.test.ts` proves held binding and description survive historical interactive actor removal, exact delayed B binds only its original provisional grant, missing B cannot publish a root, and removed accounts cannot submit fresh input or queries. Its archived-project positive also binds the already accepted root. The complete grants and actor batch passed 18 tests and 178 assertions.
- [x] Machine check: the same Service suite retains actual Runtime-owner removal rejection and released-generation reacquisition rejection without changing the root, retention generation or occupancy. Its original release/reacquire case preserves accumulated usage and old-generation capability fencing.
- [x] Machine check: the original API execution case passed in the complete grants and actor batch. The original retention suite separately passed two tests and 11 assertions, and inspection separately passed eight tests and 70 assertions, preserving current token/account checks, cleanup inspection and exact generation receipts.
- [x] Machine check: the complete original Hosted question case passed with 37 assertions through natural completion, preserving private/shared interactions and the original current-actor reply checks. The original native execution case separately passed with 21 assertions.
- [ ] Machine check: the separate test-fixture clock correction and complete canonical verification still require their owning validation; no complete CI success is claimed here.

The [decision](../decisions/implemented/bug-fix/2026-11-14-preserve-accepted-root-authority-after-actor-removal.md) retains all current Runtime, resource, Session and API authorization checks without a new protocol or grant. Service signed-fixture reconciliation and physical Native acceptance are separate validation levels.

## Lessons

Trace who owns an accepted effect before treating historical input attribution as current authorization. Distinguish provisional admission from actual B, still-held work from released reacquisition, and replying to a task from becoming that task's actor. A failed execution's original safe error can reveal an authorization defect that a completion timeout alone obscures.
