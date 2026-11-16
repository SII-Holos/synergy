# Portable reader forgot original cancellation

## Executive summary

Clearing a caller's signal after opening a portable reader bypassed cancellation. A separately cancelled in-flight chunk also returned bytes before another check. Binding original inputs and guarding both sides of each awaited read fixes both paths.

## Summary

Temporary canonical stream fixtures reproduced these behaviors and public-root replacement with an empty verified package. No user Home or Runtime was used. The enclosing native transfer contexts already have their own lifecycle guards; the shared public codec still needed to preserve its own contract independently.

## Timeline

1. A reader opened with a signal completed after that signal was aborted and removed from the original input.
2. A real chunk read held behind a barrier yielded its bytes after the original signal was aborted.
3. Both tests rejected with the exact original reason after the reader captured immutable ports and checked cancellation after awaited reads.
4. A separate test reproduced replacing the public root with an empty package; freezing the validated root preserved its original entries.

## Root cause

The reader repeatedly accessed its caller-owned input object. It checked cancellation before asynchronous blob reads without rechecking the result before yielding it.

## Guardrails

- [x] Machine check: `test/session/transfer-stream.test.ts` tests original-signal replacement and cancellation during actual chunk retrieval.

See [the decision](../decisions/implemented/bug-fix/2026-11-12-retain-portable-reader-cancellation-and-ports.md) for the ownership boundary.

## Lessons

The original cancellation remains part of a reader's identity. Checking before an asynchronous operation does not validate the result after it returns.
