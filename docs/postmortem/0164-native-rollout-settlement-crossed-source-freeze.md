# Native Rollout settlement crossed source freeze

## Executive summary

An ordinary Hosted model task reached real EOF and committed its native release, but later Runtime shutdown attempted its original Rollout recovery checkpoint after source maintenance had frozen the namespace. The source mutation guard correctly rejected that late write. A separate paused-stream experiment also exposed unresolved execution cleanup that native backup capture needed to reject without trapping maintenance release.

## Summary

The genuine Hosted recovery fixture completed Atlas and title calls through the service model gateway. Its final close attempted `rollout/recovery-v2` under the frozen source. This was exclusive Rollout settlement during shutdown, rather than proof of a detached network journal writer. Weakening source mutation admission would have hidden the ordering error.

## Timeline

1. Admit a real model task through the service and observe completed native calls, gateway EOF receipts and original release.
2. Freeze the Hosted namespace, then observe shutdown's recovery checkpoint fail the original source guard.
3. Hold a native maintenance tail, release its real Rollout write and settle only after all native owners finish.
4. Pause a real streaming task and interrupt the original upstream; require native capture to reject its unresolved generation.
5. Release maintenance, reconnect the original bridge and close normally with the original facts retained.

## Root cause

Shutdown owned final Rollout settlement, while backup maintenance did not join that owner after its later bridge and native tails. Native capture also lacked a complete canonical execution-cleanup preflight. An empty derived pending index could not prove a namespace safe to export.

## Guardrails

- Harness `test/session/rollout-pending.test.ts` verifies a held real tail and refuses freeze when original settlement fails, preserving its pending owner.
- Organization Runtime `test/backup/native.test.ts` captures normal EOF only after actual cleanup drainage and rejects a paused interrupted stream without source retirement.
- The execution-cleanup owner verifies canonical entries through complete bounded pages after its startup migration; it does not rewrite unknown outcomes.
- Refused capture preserves ordinary release, original Session binding and the native Home; the real bridge must reconnect.

## Lessons

Join the final recording owner after every accepted native tail, before an immutable source is established. Separate an unsupported backup from the ability to release maintenance and reconcile the original execution.
