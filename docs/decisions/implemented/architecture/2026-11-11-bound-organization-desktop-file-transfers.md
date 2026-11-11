# Decision Record: Bound organization Desktop file transfers

Status: implemented

## Problem

Organization publication and transcript files can exceed the control API's JSON limits. Passing complete files through renderer IPC would retain large buffers and expose privileged download behavior to an untrusted document.

## Decision

The Desktop organization bridge preserves its 64 KiB request and 2 MiB JSON response limits. Explicit publication and transcript blob routes alone accept typed byte bodies and single bounded ranges up to 4 MiB. Main owns access tokens, validates the captured trusted document and connection identity, rejects redirects, and cancels requests when their owner is replaced.

Whole-file downloads use a separate exact content-route operation. Main presents the native save dialog, streams into an exclusive temporary file beside the chosen destination, verifies the declared byte count and SHA-256, and atomically publishes only a complete file. Cancellation or integrity failure removes the temporary file and preserves the destination. Renderer receives only a saved receipt.

Organization pages reuse shared controls, fonts, themes and confirmation dialogs. Administrative mutations submit observed revisions. One-time setup, invitation and reset secrets enter through the first-party fragment, are removed from the URL before validation, and remain in component memory only.

## Alternatives considered

**Larger generic JSON IPC limits.** Base64 and complete response buffers multiply retained memory and grant generic control routes unnecessary file-transfer capability.

**Renderer-owned privileged downloads.** Supplying access tokens or a generic filesystem destination lets renderer code select authority beyond the captured organization and native save choice.

**Publish a temporary file before verification.** An incomplete or corrupt download could replace a valid destination and would make cancellation indistinguishable from success.

## Consequences

File operations require the strict byte or save protocol while ordinary generated SDK calls keep their existing transport. Real Electron tests cover non-UTF-8 structured-clone bytes, range preservation and cancellation; filesystem tests cover digest failure, temporary cleanup and atomic replacement. Native save dialog interaction remains part of Desktop product acceptance.
