# Cancelled reader retained artifact pin

## Executive summary

Closing a binary stream inside an aborted Storage queue scope failed to release its artifact pin. The cleanup submitted a pure in-memory decrement through cancellable queue admission, which rejected it. Releasing that counter synchronously in its original owner lets completed readers relinquish their bytes without weakening ordinary I/O cancellation.

## Summary

A temporary native Storage fixture reproduced the leak with actual artifact bytes and garbage collection. No user Home or active Runtime was modified. The stream correctly protected its deleted artifact while open, but collection still reclaimed nothing after cancellation and iterator closure.

## Timeline

1. The fixture wrote an artifact, read its first chunk and removed the canonical reference.
2. Collection reclaimed zero packs while the reader remained active, confirming its pin was necessary.
3. The original Storage queue scope was aborted and the iterator was closed. The existing cleanup failed queue admission; the next collection still reclaimed zero packs instead of one.
4. Synchronous pin release made iterator closure succeed and the same collection reclaim the artifact. Binary and object artifact neighbors remained green.

## Root cause

The implementation treated final in-memory bookkeeping as a new queued storage operation. Queue cancellation correctly refused that new admission, but reader finalization needed to relinquish an already-held resource. The pin had no corresponding persisted reference and remained in the Runtime's active-reader set.

## Guardrails

- [x] Machine check: `test/storage/storage-binary-stream.test.ts` — `an aborted read scope releases its open binary stream pin before garbage collection`.

The [decision](../decisions/implemented/bug-fix/2026-11-12-release-artifact-reader-pins-after-cancellation.md) defines synchronous cleanup ownership. The persistence Skill requires cancellation testing after acquisition, including collection after the original queue scope aborts.

## Lessons

Cancellation must stop new I/O without preventing deterministic release of resources already acquired. Verify that release through actual collection rather than inspecting private pin counters.
