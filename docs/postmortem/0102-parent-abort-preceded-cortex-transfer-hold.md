# Parent abort preceded the Cortex transfer hold

## Executive summary

The source coordinator paused and aborted an ordinary parent before suspending its Cortex children. A synchronous TaskTool treats an ordinary parent abort as cancellation of its delegated task. Existing transfer fixtures ran a child beneath an idle parent and therefore never exercised that callback. Real parent/tool/provider acceptance also exposed native recording jobs that outlived the lease's idle signal. Safe preparation must install child holds before the parent abort and await the complete recording tail before freezing records.

## Summary

This was found in isolated fixtures while connecting the source operation. The organization machine dispatcher was not exposed. A native child could reach the parent's abort callback before its transfer hold existed, and Core could reject an otherwise valid preparation while detached recording still ran. Protected cancellation failures could also escape the TaskTool's unobserved cancellation promise. No production handoff completion is inferred from the resulting kernel fix.

## Timeline

1. Initial queued and running Cortex transfer cases preserved the original child identity, but their parent did not execute the TaskTool.
2. Source tracing found the TaskTool's parent-abort listener called `Cortex.cancel()` before the source established its child holds.
3. A real parent invocation emitted the actual synchronous TaskTool call while the child provider waited for its native cancellation signal. The first full case exposed Core's outstanding native background-recording check.
4. Source preparation changed to child-before-parent domain suspension and awaited native recording tails. The complete scenario passed with the original child still held for transfer.
5. Replaying only the old early-parent-abort order, while retaining the other fixes, failed the event-time assertion: the child's transfer hold was absent when its parent's native lease aborted. Restoring the order passed without extra provider calls.
6. Review found that ordinary LoopJob settlement consumed recording errors. Real detached failures made repeated source preparation pass incorrectly; concurrent settlement could also hide a child's error before discovery. Native capture and non-consuming drainage rejected both attempts while leaving unrelated roots' ordinary settlement unchanged.

## Root cause

The pause latch, abort signal, domain suspension and final Storage fence were treated as one operation. They have different ownership. The latch stops further parent scheduling; the abort invokes existing child cancellation behavior; only the actual Cortex owner preserves its task, input, budget and parent intent. A lease becoming idle also does not prove every detached recording job has finished.

The TaskTool's fire-and-forget cancellation could neither propagate a native refusal nor distinguish an ordinary stop from a proven transfer or maintenance hold.

## Guardrails

Source preparation now establishes all epoch holds and suspends native domains in child-to-root order before aborting ordinary parents. Core waits for both bound and detached native recording before the final fence. The Cortex owner preserves a parent-aborted child only for the actual pause reason and matching current native hold; ordinary cancellation retains its previous behavior. TaskTool disposal awaits and propagates cancellation failures.

Source preparation captures recording failures before pause, including undiscovered descendants through their canonical parent lineage. The native failure entries retain their original error through ordinary settlement and repeated preparation. The snapshot drain can stop waiting on cancellation without cancelling or repeating the recording job. Real detached-failure and cancellation cases cover these distinctions in `test/session/transfer-source-recording.test.ts`; cold writer reconciliation remains a separate requirement.

`test/session/transfer-source-task.test.ts` runs the actual parent, TaskTool and child provider. It observes the exact native hold at the parent abort event, unchanged task/root identities, one parent and child provider invocation, stopped leases and a paused root. Separate native and tool tests exercise ordinary cancellation, incorrect parent identity and refused protected cancellation. Existing source and Cortex continuation cases remain regression coverage. See [source ordering](../decisions/implemented/architecture/2026-11-12-drain-portable-source-owners-before-final-freezing.md).

## Lessons

Parent cancellation must be tested through the actual tool boundary. A child-only fixture cannot establish parent abort semantics, and an idle lease cannot stand in for completed native recording.
