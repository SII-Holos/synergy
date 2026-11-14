# A retained preview concealed active Target preparation

## Executive summary

An instrumented native-directory adoption case failed after 31.913 seconds while reconciling its original Target preparation. The Target inspection path could report an earlier permanent difference preview as complete ahead of a matching active preparation job. Historical signed evidence must remain distinguishable from completion of the operation being observed.

## Summary

The original complete case accepted its exact native difference, closed and reopened the destination, then issued one preparation mutation. Its five-second foreground observation ended, and the fresh inspection was rejected by the strict completion observer because it had no matching signed terminal fact. This was a behavioral failure before the unchanged forty-five-second framework guard. The original log did not retain the response's individual proof checks, so controlled reproduction is required before assigning its exact returned purpose or excluding another proof mismatch.

## Timeline

- The original coverage run reached cold reopening at 25.693 seconds, inspected at 25.875 seconds and began preparation at 25.950 seconds.
- After the foreground window, inspection began at 30.955 seconds. The completion observer failed and normal cleanup ran; the case ended after 31.913 seconds.
- Source tracing found that retained difference facts determined inspection state, stage and revision before its matching job could report working.
- A controlled extension held the original native file-preparation callback after the cold reopen. Original production returned complete/target-difference instead of working/preparing, reproducing the mismatch without a timeout.
- After the projection fix, the original controller and all three native-directory cases passed: four cases, 168 assertions. The positive case preserved its forty-five-second guard, original signed comparison, complete native bytes/history and independent Continue. Current-head instrumented and platform acceptance remain separate gates.

## Root cause

Preview and preparation share a native handoff identity and prepared epoch while retaining different owner facts. Inspection selected the old difference fact when no preparation receipt existed, then used any selected fact to report complete. A matching preparation job therefore remained hidden. Reading the job only after asynchronous receipt reads also allowed job completion and deletion to overtake an earlier receipt observation.

Inspection must retain the old signed difference as historical evidence while reporting the matching active job as working/preparing. The actual prepared, activated and permanent retirement outcomes retain precedence. Capturing the job before receipt reads conservatively permits another fresh inspection when publication crosses those reads. Binding, native epoch and signature checks remain unchanged; increasing a deadline or accepting the wrong terminal fact would not repair this projection.

## Guardrails

- [x] Machine check: `packages/organization-runtime/test/handoff-native-existing.test.ts` — retain the real accepted difference through cold reopening, hold the original exact-binding native file owner, require working inspection with the original signed comparison, then complete the same preparation through the strict receipt observer.
- [x] Machine check: `packages/organization-runtime/test/handoff-target.test.ts` — retain existing held preparation, immutable mapping, paused activation, rollback and cold-recovery controls.
- The [destination decision](../decisions/implemented/architecture/2026-11-12-prepare-and-adopt-native-handoff-destinations.md) defines historical preview evidence separately from current preparation completion.

## Lessons

Match a terminal fact to the operation being reconciled. A correctly signed predecessor does not make a later native operation complete, and a finite foreground observation does not cancel accepted work.
