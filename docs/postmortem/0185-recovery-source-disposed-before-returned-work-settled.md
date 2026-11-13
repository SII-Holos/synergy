# Recovery Source disposed before returned work settled

## Executive summary

A genuine fresh-Target collision was correctly rejected, but its returned Promise temporarily had no rejection owner while Source disposal ran. The caller eventually caught the same error and verified safe final state, after the test runner had already reported an unhandled rejection. Resource ownership must include awaiting the returned operation before asynchronous disposal.

## Summary

The recovery preflight rejected historical Member metadata claiming the actual new publication incarnation. Its original Source and Target remained safe. Changing the assertion style did not fix the failure: all typed error and final-state checks executed, while the same rejection appeared earlier.

## Timeline

Local owner markers showed the same error propagating through writer preflight, Current capture and Snapshot capture before the outer recovery catch. Independent tracing identified an `await using source` callback returning `source.run()` without awaiting it. The disposer waited for the inner tracked work and continued asynchronous cleanup while the outer returned Promise rejected. Awaiting that Promise before disposal closed the missing interval; the original real negative, Member recovery and command cases passed together.

## Root cause

The asynchronous callback began resource disposal before adopting its returned Promise. Service shutdown tracked the operation inside `runMaintenance`, which did not itself attach a rejection owner to the distinct outer Promise being returned from the resource scope.

## Guardrails

Recovery awaits the Source-owned operation before leaving its asynchronous resource scope. The real collision regression preserves the exact native guard and error, checks held Target identities, leaves the Source and offline Member private Home unchanged and starts no native execution. No global rejection handler or error suppression is used.

## Lessons

Tracking inner native work does not replace awaiting the public operation returned from an asynchronously disposed handle. Keep failure ownership attached through cleanup.
