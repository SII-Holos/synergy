# Environment admission outlived Session authority

## Executive summary

A Session could publish a frozen epoch while its original Environment allocation was still waiting. A separately reproduced native command could first start after a Session pause while its submitted receipt was waiting for a connection. Exact request ownership, final freeze checks and admission revalidation now retain those asynchronous boundaries.

## Summary

Private fixtures held the real provider callback before receipt creation and observed `Epochs.freeze` resolve. The same failure occurred while Resources was allocating or connecting before Execution was entered. A Local Runtime fixture then held the actual native Executor connection after the submitted record existed, paused the Session and observed the start path resolve instead of refusing dispatch. No real user Home or running product instance was used.

Independent review also reproduced four configuration changes that retained the same object identity: replacing the Store namespace or the artifact configuration's blob port, writer identity or clock. The original capability still passed its guard. After correcting that capability, all four deferred Session-index iterators still resolved instead of rejecting; their separate owner guard needed the same immutable configuration snapshot.

## Timeline

1. A canonical Session/root/tool fixture began an execution and stopped its provider allocation behind a barrier.
2. Pausing and starting source drainage still allowed final epoch publication; the behavioral test rejected that result.
3. Exact Store-bound request tracking and canonical operation checks made final publication reject until the original provider settled.
4. Testing the production Resources preparation boundary reproduced the same missing lifetime before any execution receipt existed. It now joins the same pending evidence and rechecks Task authority after preparation.
5. A real native connection held after submission exposed a separate first-dispatch gap. Revalidation now refuses the command and asks the original Executor to record cancellation. Its confirmed no-effect tombstone allows normal saving and release; uncertain outcomes remain retained.
6. Same-object namespace and artifact configuration fixtures failed first at the origin guard, then at the deferred index guard after the origin fix. Both guards now compare the originally selected configuration as well as object identity.

## Root cause

Receipt persistence and execution authority were checked at different times. Neither an empty operation index nor a successful earlier admission accounted for asynchronous preparation still owned by that Session. A command waiting to obtain its Executor had not yet crossed the physical-effect boundary.

## Guardrails

- [x] Machine check: Harness `test/environment/execution-origin.test.ts` holds allocation and connection before receipt creation, verifies freeze refusal, and verifies observer cancellation preserves the original request.
- [x] Machine check: the same suite covers missing index coverage, cold legacy ownership and Store-bound pending/iterator behavior.
- [x] Machine check: Local Runtime `test/environment/bash.test.ts` holds the actual native connection after submission, pauses the Session, and requires zero command markers plus confirmed no-effect cancellation and use release.
- [x] Machine check: Harness `test/environment/origin.test.ts` mutates the same Store namespace and replaces the same artifact object's blob port, writer identity and clock; both captured origins and deferred index iterators reject.
- [x] Procedure: the [persistence workflow](../../.synergy/skill/change-persistence/SKILL.md) requires accepted native admissions to remain discoverable through their actual preparation lifetime.

## Lessons

A receipt is not the beginning of an accepted operation's lifetime. Retain preparation ownership before awaiting providers, and revalidate the current authority before the first physical effect. Cancellation and output settlement must use the original native owner.

See the [decision](../decisions/implemented/architecture/2026-11-12-retain-native-environment-operation-origins.md) for canonical provenance, storage migration and coverage boundaries.
