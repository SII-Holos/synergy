# Native Bash abort outlived command completion

## Executive summary

Native Bash retained neither its cancellation completion nor its abort fallback timer. A command could return while cancellation still used storage, and a completed child could leave a captured Runtime callback scheduled for 30 seconds later. Command ownership must cover both the original cancellation and every registered callback.

## Summary

A Presets CI failure entered a disposed predecessor Runtime from the native Bash abort fallback. A real-child regression independently exposed cancellation reconciliation after command completion. These are two unfinished operations of the same command owner.

## Timeline

- The original CI callback registration pointed to Bash's abort handler; its predecessor Runtime had already been disposed.
- A real native child was aborted only after readiness output, then command completion and execution release were awaited. The original implementation failed through late cancellation into closed storage.
- Retaining and draining the original termination removed that earlier failure. The unchanged fallback then entered the closed Runtime after its original 30-second interval.
- Owning and clearing that timer on native exit and closure made the complete regression and original Bash cases pass.

## Root cause

The abort handler launched termination without retaining its completion. The child-close path waited for native completion and output but omitted that cancellation promise. Separately, its bound fallback was created without storing the timer handle, so existing cleanup could not retire it. The captured context correctly rejected both late entries.

## Guardrails

- [x] Machine check: `packages/local-runtime/test/environment/bash.test.ts` — real native abort, command completion, original Runtime closure, subsequent Runtime activity and the original 30-second callback interval.
- [x] Machine check: the original Bash Environment, split UTF-8, paused activation and explicit-background cases in the same suite.
- The [Runtime ownership workflow](../../.synergy/skill/architecture/references/runtime-ownership.md) requires cancellation drainage and timer retirement through the original process owner.

## Lessons

Physical exit, output completion and released resources do not by themselves establish cancellation completion. A fallback remains owned work even when its callback would do nothing after successful exit: entering its captured Runtime is itself an operation that must be retired.
