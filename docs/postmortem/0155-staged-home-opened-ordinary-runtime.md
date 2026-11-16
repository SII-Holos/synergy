# Staged Home opened an ordinary Runtime

## Executive summary

A real format-three installation marker and unfinished native intent were accepted by the generic Runtime startup. A temporary native fixture reached readiness even though recovery publication had not completed.

## Summary

A native format-three identity marks an installation whose completion and original recovery release must still be verified. Reaching Runtime readiness first can expose migrations, Session staging and service startup effects.

## Timeline

An actual temporary staged Home reached generic Runtime readiness in the regression fixture. Adding the post-attachment guard made the same fixture reject before Session staging. A second actual cold Target test exposed opening modes in the persisted dataset hash. The owning publication tests retain cold and read-only validation without granting read-only writes.

## Root cause

The Home restoration owner was not registered in the base lifecycle, and ordinary startup did not validate it after attaching the actual Store. A format-three file identifies an installation; it does not prove a completed publication or released recovery hold.

## Fix

Register the owner and call its ordinary-startup check before Session staging and migrations. Reuse the existing native codec through a Node-compatible leaf instead of adding another parser. Keep the actual SQL publication/native-ready/released checks after attachment.

Cold restoration also exposed a related distinction: dataset hashes included must-exist/read-only opening modes. Normalize those modes only in persistent dataset identity. Exact live options and writable checks remain mandatory at native effect and release entry points.

## Guardrails

`packages/harness/test/lifecycle/home-restoration.test.ts` opens the actual staged Home and requires rejection before ordinary readiness. `test/storage/runtime-maintenance-adoption.test.ts` preserves cold publication behavior and proves that a read-only Handle can read completion but cannot complete or release it. Callback-bound publication inspection expires with the original Runtime/native owner.

## Lessons

Native installation metadata, published domain state and execution admission are separate proofs. A native completion preflight is useful before SQL attachment but cannot replace the owning post-attachment guard.
