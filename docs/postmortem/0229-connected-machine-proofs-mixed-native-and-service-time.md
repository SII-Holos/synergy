# Connected machine proofs mixed Native and Service time

## Executive summary

A validly signed Native execution proof could be rejected by its Service because the producer used its own machine's wall clock. Related queue, Gateway and handoff checks used that same unqualified clock. Live Service-time windows need one connection-owned observation throughout the actual execution chain.

## Summary

The actual cross-platform handoff completed preparation, surrender, commit, activation and file/history checks, then failed after independent Continue at execution authorization. The retained public error did not contain its cause. A same-data same-platform counter completed that original authorization, so it did not establish the cross-platform failure's cause.

## Timeline

- The original Linux execution failed before its second Tool, after independent Continue returned.
- The actual same-platform data and authorization counter passed.
- Advancing only the Target Runtime wall clock by 999ms caused one original signed description request to reach the Service with a verified signature and its unchanged 30000ms lifetime. It was unexpired but 994ms in the future; the original response was 403 with the validity-window error.
- The connected proof, queue and subsequent capability consumers were corrected together. A single persistent Target offset exercises the original complete native return path; it does not substitute for the actual two-OS run.

## Root cause

Absolute Service deadlines were compared with Native timestamps. A local success could hide this while both participants shared a host clock. Earlier handoff object work already needed its accepted Service-plan clock; fixing that one operation did not qualify later execution and Gateway timestamps.

## Guardrails

The [decision](../decisions/implemented/bug-fix/2026-11-17-use-service-time-for-connected-machine-proofs.md) defines the live connection time source and the limits of worker transport age. The implementation preserves every original signature, binding and expiry gate. Native record dates and offline recovery stay with their owners. Real execution/Gateway controls cover positive and negative Native wall-clock offsets, and original worker tests retain signature, expiry, single-dispatch and cancellation checks alongside call-bound snapshot rejection. The original full cross-platform fixture retains all OS, byte, history, continuation and cleanup assertions under one persistent Linux Runtime offset.

## Lessons

Trace a failing distributed chain's time producers and consumers together. A green ordinary CI run, a valid signature, and a successful Continue each prove different facts; none alone establishes the complete cross-platform result.
