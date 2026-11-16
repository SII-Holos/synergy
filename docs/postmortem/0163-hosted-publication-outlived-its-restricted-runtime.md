# Hosted publication outlived its restricted Runtime

## Executive summary

A restricted Hosted target tracked explicit `run()` callbacks but omitted its publication owner's accepted native work from shutdown. An observer could accept completion and return, allowing shutdown to release the original Store and process lock while that completion still held a native write.

## Summary

The real recovery fixture held the registration file publication, returned from the observer and closed the restricted target. The native completion then failed because its original installed-writer ownership had already been released. The persisted recovery hold remained intact; the test did not replace the original guard or mark the target ready.

## Timeline

1. Commit the original Hosted publication under the verified service mapping.
2. Accept independent native completion and hold its actual registration file write.
3. Return from the observing `run()` callback and close the restricted target.
4. Observe the original process-lock lifetime end before completion resumes.
5. Drain the registered publication owner before Store/process-lock closure and verify ordinary startup after the held write completes.

## Root cause

The publication owner already retained its mandatory completion promises, but the restricted target's close path only waited for top-level `run()` callbacks. Observer completion was incorrectly treated as completion of its accepted native effects.

## Guardrails

- `packages/organization-runtime/test/backup/native.test.ts` holds the actual registration write after its observer returns and requires close to remain pending.
- Restricted target shutdown consumes the publication owner's own drainage before closing its primary Store or native lock.
- Cleanup reports aggregated failures while still attempting the remaining original resource releases.
- An observer's return or cancellation cannot turn a committed publication into rollback or authorize a replacement installation.

## Lessons

Drain accepted effects through their owning registry independently of the callback that observed them. Retaining a domain promise is insufficient unless the actual native shutdown path joins it.
