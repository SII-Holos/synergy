# Cohort release reopened Hosted before Service

## Executive summary

Parallel Cohort cleanup allowed a Hosted namespace to release while its prerequisite Service release failed. The Hosted bridge can therefore restart before Service admission reopens. Release the Service first and retain dependent native holds when that release fails.

## Summary

This was a controlled reproduction using the original enrolled Hosted Runtime, real Service, native maintenance owners and opaque leases. It is not an observed credential-revocation incident and does not establish the cause of a separate four-second task-release failure.

## Timeline

- Source tracing found parallel Service and Hosted release after Cohort capture.
- The regression held the original Service release and cancelled that actual release through its existing signal.
- The original aggregate preserved the exact cancellation, and Service remained frozen. After cleanup settled, Hosted was already released where the test required its hold to remain frozen; eight assertions reached that failure.
- Corrected execution reached fifteen assertions covering retained holds, explicit same-lease recovery, authenticated WSS, a second complete capture and released native states. Its final model task then failed the unchanged first-request barrier with zero upstream requests; the whole case did not pass.

## Root cause

Cleanup treated independent namespace storage as independent service lifecycles. The original Hosted released callback starts its bridge, which depends on a successfully reopened Service. The parallel cleanup attempted Hosted release even when that prerequisite failed.

## Guardrails

- [x] Native owner regression: `packages/organization-runtime/test/backup/native.test.ts` — controlled original Service release cancellation, exact aggregated error and retained native holds, followed by explicit recovery through the same live Runtime and original opaque leases, higher-epoch authenticated WSS, another complete native capture and released owner states. The complete owner case passes with fifteen assertions after removing its redundant model startup tail.
- Existing model integration remains separate in the same file: genuine task recovery without replay, published Artifact recovery, H1 and second-input refusal, and model writer drainage before ordinary shutdown. Their original model and release checks remain unchanged. They do not reproduce this exact cancelled-release history; removing the extra tail does not fix or erase its original four-second, zero-request failure.
- The [release-order decision](../decisions/implemented/bug-fix/2026-11-15-release-service-before-hosted-backup-cohorts.md) preserves failure ordering, opaque ownership and cold-reconciliation separation.

## Lessons

Trace dependent restart effects before parallelizing cleanup. Observe the actual owner state after all original cleanup attempts settle; callback timing or a socket close code alone cannot establish release correctness. A controlled frozen case does not mean every earlier capture failure leaves the same phase. Keep the regression at the lowest real owner and protocol layer that rejects the defect, reuse existing model integration for its distinct task contract, and record the removed combination and its original failure instead of extending clocks or prewarming its cold model path.
