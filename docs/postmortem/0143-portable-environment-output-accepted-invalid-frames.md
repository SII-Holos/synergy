# Portable Environment output accepted invalid frames

## Executive summary

Completed Environment history checked output addresses, cursor coverage and authenticated package bytes, but accepted output data that was not canonical Base64. A package with recomputed hashes could therefore pass validation while its consumer silently discarded invalid characters. The portable frame reader also retained Buffer views instead of independent bytes, allowing an iterator to change a previously yielded frame.

## Summary

The output contract required a bounded string without validating its encoded payload. Byte authentication established that the supplied package was complete; it did not establish that those bytes represented valid native output. Separately, `Buffer.slice()` retained the producer's backing memory until the complete frame was concatenated.

## Timeline

- Read-only probes showed that `"!!!!"` passed native frame validation and decoded to empty output, and that reusing a yielded Buffer changed the retained frame.
- Before production changes, six malformed or noncanonical Base64 cases failed their new rejection assertions. A reusable Buffer iterator that cleared its yielded bytes caused JSON parsing to fail.
- The real native execution transfer fixture rewrote an output frame to `"!!!!"`, recomputed the package through the existing stream writer, and completed staging verification. Environment owner validation incorrectly resolved instead of rejecting.
- Canonical payload validation moved into `ExecutionProtocol.Chunk`, and the portable reader began copying each yielded byte chunk independently.

## Root cause

The shared native output schema validated only string length. Permissive Base64 decoding could discard invalid characters, accept missing or excessive padding, ignore whitespace and accept nonzero pad bits. Package hashing and cursor completeness could not detect that semantic error.

The portable reader used the typed-array `slice()` expectation on a value that could be a Node Buffer, whose `slice()` returns a shared view. This was reproduced through the public iterable contract. The default ArtifactPack reader creates fresh chunk buffers; the regression does not claim that reader reuses them.

## Guardrails

`ExecutionProtocol.Chunk` requires the bounded payload to equal its decoded bytes encoded back to Base64. `EnvironmentExecutionPortable.validateChunk()` takes independent byte copies and returns the original JSON bytes after validation, preserving whitespace, field order and retained frame fields.

Harness `test/environment/execution-portable.test.ts` rejects invalid alphabet, missing/excess padding, whitespace and nonzero pad bits, and verifies empty/binary payloads and reusable-buffer snapshots. Local Runtime `test/session-transfer-environment-history.test.ts` rejects fully rehashed invalid and noncanonical packages before publication while preserving the existing real execution, rollback and cold output checks.

## Lessons

An authenticated complete artifact still needs its owning protocol's semantic validation. Copy deferred stream bytes according to the concrete buffer type's ownership semantics. See [the decision](../decisions/implemented/bug-fix/2026-11-12-validate-canonical-native-output-before-portable-publication.md).
