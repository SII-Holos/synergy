# Decision Record: Bound organization Desktop file transfers

Status: implemented

## Problem

Organization publication and transcript files can exceed the control API's JSON limits. Passing complete files through renderer IPC would retain large buffers and expose privileged download behavior to an untrusted document.

## Decision

The Desktop organization bridge preserves its 64 KiB request and 2 MiB JSON response limits. Explicit publication and transcript blob routes alone accept typed byte bodies and single bounded ranges up to 4 MiB. Main owns access tokens, validates the captured trusted document and connection identity, rejects redirects, and cancels requests when their owner is replaced.

Whole-file downloads use a separate exact content-route operation. Main presents the native save dialog, streams into an exclusive temporary file beside the chosen destination, verifies the declared byte count and SHA-256, and atomically publishes only a complete file. Cancellation or integrity failure removes the temporary file and preserves the destination. Renderer receives only a saved receipt.

Private field saves use a strict typed query, native version, reference and captured Session binding instead of a URL or filesystem path. Main chooses its supervised member or the generated transient organization read operation, retaining the [private read authorization](2026-11-11-read-private-sessions-through-bounded-native-contracts.md). Each bounded field chunk revalidates identity and binding. Preparation returns progress before opening a save dialog; preparation after a verified prefix aborts the temporary output. The saved receipt preserves whether the original retained content is complete or partial.

Attachment saves accept only a canonical message/part/version target and captured binding. Main obtains the filename, media type, byte count and digest from the [canonical producer evidence](2026-11-12-read-session-attachments-from-canonical-producer-evidence.md) before opening the picker. It reuses the captured member or remote read transport, with at most 64 KiB per chunk, awaited writes and a final incremental digest. Missing or partial evidence returns an explicit unavailable outcome without opening the picker; loss of that evidence during saving removes staged bytes. A renderer cannot supply a hash, asset URL, native path or alternate filename to this action. Filename sanitation affects only the OS save suggestion; immutable descriptor checks retain the original native metadata.

Explicit native saves can continue while bytes make progress. They keep cancellation and finite response/chunk idle deadlines instead of the ordinary control operation's total deadline. Empty stream chunks do not renew progress, and the field consumer rejects repeated offsets. An idle deadline aborts the captured transfer owner, allowing the caller to finish even while an uncooperative dependency still holds its response. Publication still requires a verified complete digest and an uncancelled owner.

Organization pages reuse shared controls, fonts, themes and confirmation dialogs. Administrative mutations submit observed revisions. One-time setup, invitation and reset secrets enter through the first-party fragment, are removed from the URL before validation, and remain in component memory only.

## Alternatives considered

**Larger generic JSON IPC limits.** Base64 and complete response buffers multiply retained memory and grant generic control routes unnecessary file-transfer capability.

**Renderer-owned privileged downloads.** Supplying access tokens or a generic filesystem destination lets renderer code select authority beyond the captured organization and native save choice.

**Publish a temporary file before verification.** An incomplete or corrupt download could replace a valid destination and would make cancellation indistinguishable from success.

## Consequences

File operations require the strict byte or save protocol while ordinary generated SDK calls keep their existing transport. Real Electron tests cover non-UTF-8 structured-clone bytes, range preservation and cancellation; filesystem tests cover digest failure, temporary cleanup and atomic replacement. Native save dialog interaction remains part of Desktop product acceptance.

Native field tests exercise actual temporary files, UTF-8 bytes across bounded reads, retained partial output, preparation before and during saving, and binding changes during the picker. A short configured control deadline verifies that progressing saves can outlive it while an idle held native response terminates without opening the picker. Attachment tests retain non-UTF-8 bytes through native and remote generated calls, reject another creator before the picker, recheck binding afterward, and preserve an existing file after cancellation, corrupt content or lost evidence. This verifies the typed Host action and filesystem pipeline; renderer presentation and real OS picker acceptance remain separate checks.
