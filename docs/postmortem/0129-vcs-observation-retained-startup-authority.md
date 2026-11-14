# VCS observation retained startup authority

## Executive summary

A mounted Workspace's branch never appeared after activation because its observer omitted the required native origin. The observer also retained its startup task, while public cache reads did not validate their calling resource frame. Shared observation needs its own composed Host and short-lived access tasks, with separate validation of original callers.

## Summary

The Workspace VCS state bound `currentBranch` to the first caller's async context. That callback could survive the caller's access task and resources. Its mounted-view resource resolution supplied no origin, and its broad unavailable-branch handling hid the admission failure.

## Timeline

1. A genuine native Environment and object-backed Workspace fixture verified zero dormant allocation calls and no Environment Uses.
2. The test closed the startup access task, created a real Git repository in the activated Workspace, and published a Workspace resync. Branch refresh timed out against the unchanged implementation.
3. A native-directory test showed that initialization accepted a resource frame with no origin.
4. A real canonical Session paused while native Workspace validation was held; the original pending branch read still resolved instead of rejecting.
5. Workbench registered its VCS Host during composition, detached watcher callbacks from caller contexts, and validated original public-call admission before and after preparation.

## Root cause

The observer combined a Workspace lifetime with a caller Task lifetime. Mandatory native origin admission was added to resource resolution without converting this caller, and catch-to-absent behavior masked that mismatch. Cache reads treated successful shared initialization as sufficient authority for every caller.

## Guardrails

- [x] Machine check: `packages/workbench/test/project/vcs-environment.test.ts` executes real Git work after the startup task closes, checks the persisted VCS Host origin, qualified branch events, zero dormant allocation calls and release without reallocation.
- [x] Machine check: `packages/workbench/test/project/vcs-origin.test.ts` rejects missing and foreign origins, checks immutable Workspace selection, and pauses a canonical Session during actual native Workspace validation.
- [x] Machine check: `packages/workbench/test/project/vcs-branch-watcher.test.ts` retains HEAD filtering, trailing refresh and disposal coverage.

## Lessons

An independently owned observer and its public caller have separate admission lifetimes. Detaching the observer must not replace the caller's provenance. The [decision](../decisions/implemented/bug-fix/2026-11-12-own-vcs-observation-outside-startup-tasks.md) records the ownership rules.
