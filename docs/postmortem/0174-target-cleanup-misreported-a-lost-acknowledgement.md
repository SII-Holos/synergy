# 0174: Target cleanup misreported a lost acknowledgement

## Executive summary

Native Target retirement and its service proof could commit while the caller received an empty acknowledgement. The generic failure helper then reported `not_dispatched`. Cleanup needed to preserve uncertainty after the native effect and retain final response ownership checks independently of its expired native capability.

## Summary

An unverifiable response cannot undo permanent Epoch retirement or a released physical Workspace claim. Callers need the retained original fact to reconcile that outcome without performing cleanup again.

## Timeline

- A preparation-only timeout occurred before fault injection and did not establish this defect; the original budget was retained.
- The same real fixture later reached the fault barrier. Native retirement and service proof committed, the HTTP response became empty, and the expected `unknown` assertion failed after 71 assertions.
- The Target acknowledgement tail now preserves uncertainty and retains the original owner checks. The native capability still ends immediately after its callback.

## Root cause

The response tail used a helper whose fixed outcome was `not_dispatched`, even though it ran after the native operation. Its ownership assertion also lived only inside the native capability, leaving post-callback validation without the same final checks.

## Guardrails

- [x] Machine check: `packages/organization-runtime/test/handoff-cloud-workspace.test.ts`, `return-adopt-runtime-revoked-cleanup`, verifies committed native retirement, empty/wrong ACK, post-commit cancellation, restricted close and cold original-fact inspection without another release.
- Keep structured service rejections and known native callback failures distinct from unverifiable post-effect outcomes.
- See [the decision](../decisions/implemented/bug-fix/2026-11-13-preserve-uncertain-target-cleanup-acknowledgements.md).

## Lessons

An operation's effect boundary determines its uncertainty semantics. Closing an effect capability does not end the need to validate the owner of its final response.
