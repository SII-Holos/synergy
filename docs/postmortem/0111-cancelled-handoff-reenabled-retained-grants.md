# Cancelled handoff reenabled retained grants

## Executive summary

An isolated first-handoff cancellation left the original source generation held. Clearing the active handoff lock made an old input binding proof usable again. A capability reserved before the handoff could also pass gateway authorization. Execution now checks the permanent cancellation's exact command cutoff, independently of the active lock.

## Summary

The reproduction used temporary service storage, real WebSocket participants and an isolated local upstream. No user Runtime, Home or model data was touched. Retained resource occupancy remains distinct from permission to start another effect.

## Timeline

1. A source bound its original root and reserved one gateway capability.
2. The service prepared a handoff, then accepted a signed source cancellation without closing the held generation.
3. An updated current-connection proof for the old input successfully rebound the same generation. The earlier tests covered cancellation after closure or after an existing continuation and missed this initial held case.
4. A shared eligibility check against the canonical reserved-epoch outcome rejected old binding, new reservation, old capability authorization and actual invocation; the isolated upstream received no old dispatch.
5. An independent Continue retained the original root with a new grant, and a genuinely new ordinary task after the cutoff dispatched successfully. Retention inspection and terminal cleanup remained available.

## Root cause

The active handoff ID fenced execution during preparation. After cancellation that lock disappeared, while the original held grant had no continuation provenance or closure cause. A native pause alone could not fence a previously issued service capability. Current command sequence also cannot identify which prior commands crossed a particular handoff barrier.

## Guardrails

Handoff preparation updates an owning derived Session/reserved-epoch index in its transaction. A bounded central migration rebuilds it from canonical records. Execution resolves the exact latest reservation from the directory, rechecks its tuple, permanent outcome and source evidence, then compares canonical input/control reception against its frozen cutoff. Bind, description and gateway owners share this predicate; cleanup does not use it.

`test/execution-cancel-barrier.test.ts` retains the original failure, exact old-capability dispatch rejection, missing-index recovery, canonical independent control, new ordinary task dispatch and terminal cleanup. Enrolled-Home controller tests cover native retained-source cancellation and a separately authorized Continue. The [decision](../decisions/implemented/architecture/2026-11-12-close-handoff-resource-generations-without-input-replay.md) records the resource-generation and execution boundaries.

## Lessons

A released lock does not revoke authority issued before it. Retained source occupancy can survive cancellation, but every new effect must still cross the exact permanent barrier through a new accepted intent.
