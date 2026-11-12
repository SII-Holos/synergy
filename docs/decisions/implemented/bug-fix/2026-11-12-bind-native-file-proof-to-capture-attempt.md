# Decision Record: Bind native file proof to its capture attempt

Status: implemented

## Problem

One native physical lease can retry capture. Its phase can return from a failed attempt to `captured` after a later callback succeeds. A file candidate holding only that lease could regain authority even though its own final physical validation failed.

## Decision

`NativeSessionTransferPhysical.sourceCaptureVerifier(binding)` returns the original assertion closure for the current native callback frame. The frame belongs to the actual lease/Runtime/Store, is open only during that callback and becomes completed only after final native validation succeeds. Starting another attempt replaces the current frame. Failed or superseded frames cannot become valid again when the same lease reaches `captured`.

The original `sourceCapture` lease and physical claim semantics remain unchanged. File owners use the attempt verifier for their bytes in addition to native lease ownership. Successful retained attempts remain valid until replaced, aborted or released. The Source file owner separately records completed frozen closure metadata; a persisted hash does not replace this native proof.

## Alternatives considered

**Check the lease phase.** A later callback can move the same lease back to `captured`, making the earlier failure indistinguishable.

**Count attempts in the file exporter.** The physical owner alone observes its final validation and cleanup. A second counter would infer authority from another component's call sequence.

## Consequences

File candidates bind one concrete capture attempt without changing the lifetime of existing physical claims. Retry creates a new verifier and cannot revive old byte authority. Cancellation and release continue to preserve their original owners and errors.

## Verification

`test/workspace/session-physical-transfer.test.ts` injects a real failure in final installed-writer validation, retries an empty callback on the original lease and proves the old verifier remains invalid while the successful attempt works until release. Source export fixtures exercise the corresponding durable candidate path. See [the incident](../../../postmortem/0110-native-file-proof-revived-after-retry.md).
