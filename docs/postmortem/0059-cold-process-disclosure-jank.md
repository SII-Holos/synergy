# Cold process disclosure jank

## Executive summary

Opening recorded execution details could pause, change height repeatedly and repeat body reads because empty pending measurements changed virtual membership. A motion binding outlived its conditional node, while opacity-only disclosure removed space abruptly after fading. Warm fixtures and settled-layout checks missed pending demand and close/reopen lifetimes. Pending geometry must share the virtual estimator, and animation ownership must follow the actual DOM mount.

## Summary

An isolated production Web build used existing history containing 554 messages and 2991 Parts. A visible 33-action batch changed height through 320, 122, 84, 150 and subsequent intermediate sizes back to 320 px while loading. At one frame, 12 of 14 mounted rows were still empty layout boxes. One request trace contained 125 body requests for 37 distinct versioned targets, up to six requests for the same target, and 112 cancelled requests. Counts vary with response and measurement ordering. Four-times CPU throttling exposed a maximum animation-frame interval of about 116 ms; this pressure result is separate from ordinary-speed interaction.

A browser-only diagnostic reservation for empty rows kept the window at 320 px and produced 32 body requests for 32 distinct targets. That temporary CSS was a causal probe, not the shipped estimator. Reopening recorded an animation against an element with `isConnected:false` before the replacement animated. The diagnosis establishes retained DOM ownership, not an unbounded heap-growth claim.

## Timeline

- Initial isolated history reproduction found cold expansion shrinking and refilling the process window.
- Per-frame geometry and versioned request traces linked empty measurements to consumer churn.
- A browser-only space reservation removed the churn without changing request cancellation.
- Close/reopen instrumentation exposed a detached animation target. Behavioral tests reproduced both causes before the fix.

## Root cause

Pending Part bodies had no meaningful reserved height. Their small measured boxes entered the inner virtualizer's size model, changing the mounted demand window. Lease release correctly cancelled unaccepted reads, but remounting requested them again. The motion reference survived its conditional content subtree and still held its element; unrelated row updates could also retrigger its visibility effect. Manual disclosure used opacity without a coordinated space transition.

## Guardrails added

[Process disclosure preparation and motion](../decisions/implemented/bug-fix/2026-10-08-process-disclosure-preparation-and-motion.md) records the shipped estimator, mount-owned binding and bounded manual space transitions. Behavioral regressions hold body reads pending, require a bounded consumer window without repeated reads, verify connected animation targets and interrupted closing, and retain the answer through parent disclosure. Existing reading, focus, selection and chronology regressions remain in the conversation suite.

A production recheck of the same history recorded 13 body reads for 13 targets with no cancellation in its cold batch sample. In a separate 20-cycle disclosure run after warmup, DOM nodes stayed at 2067 and JavaScript event listeners at 409. GC heap samples ranged from approximately 29.1 to 29.6 MB; the final sample was 29.3 MB. Both heap snapshots contained 130962 closures, and detached-DOM inspection found no retained process window, virtualizer or batch-content nodes. All 44 observed animations targeted connected elements. These observations cover disclosure ownership in this history, rather than asserting a global memory-growth bound.

## Lessons

Pending content needs explicit provisional geometry under the same estimator as its virtual window. Motion ownership must follow the actual conditional DOM mount, with visibility independent of unrelated data updates. Validate cold expansion and interrupted space motion separately from settled layout and ordinary-speed latency.
