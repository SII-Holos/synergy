# Decision Record: Bound organization Desktop file transfers

Status: implemented

## Problem

Organization publication and transcript files can exceed the control API's JSON limits. Passing complete files through renderer IPC would retain large buffers and expose privileged download behavior to an untrusted document.

## Decision

The Desktop organization bridge preserves its 64 KiB request and 2 MiB JSON response limits. Explicit publication and transcript blob routes alone accept typed byte bodies and single bounded ranges up to 4 MiB. Main owns access tokens, validates the captured trusted document and connection identity, rejects redirects, and cancels requests when their owner is replaced.

Whole-file downloads use a separate exact content-route operation. Main presents the native save dialog, streams into an exclusive temporary file beside the chosen destination, verifies the declared byte count and SHA-256, and atomically publishes only a complete file. Cancellation or integrity failure removes the temporary file and preserves the destination. Renderer receives only a saved receipt.

Private field saves use a strict typed query, native version, reference and captured Session binding instead of a URL or filesystem path. Main chooses its supervised member or the generated transient organization read operation, retaining the [private read authorization](2026-11-11-read-private-sessions-through-bounded-native-contracts.md). Each bounded field chunk revalidates identity and binding. Preparation returns progress before opening a save dialog; preparation after a verified prefix aborts the temporary output. The saved receipt preserves whether the original retained content is complete or partial.

Attachment saves accept only a canonical message/part/version target and captured binding. Main obtains the filename, media type, byte count and digest from the [canonical producer evidence](2026-11-12-read-session-attachments-from-canonical-producer-evidence.md) before opening the picker. It reuses the captured member or remote read transport, with at most 64 KiB per chunk, awaited writes and a final incremental digest. Missing or partial evidence returns an explicit unavailable outcome without opening the picker; loss of that evidence during saving removes staged bytes. A renderer cannot supply a hash, asset URL, native path or alternate filename to this action. Filename sanitation affects only the OS save suggestion; immutable descriptor checks retain the original native metadata.

The private transcript presents bodyless attachment metadata with shared file icons and controls. Its one active preview may retain at most 256 KiB of verified text or supported image bytes; closing, changing source, replacing the native version or losing access releases its body and object URL. Image previews exclude active formats such as SVG, and text remains escaped. Downloads use the separate streaming save path without this preview size limit. Web uses a writable file handle when supported and aborts it on failure; unsupported browsers receive explicit guidance instead of buffering an arbitrary file into a Blob. Private header filenames and hashes never become ordinary Asset URLs.

Tool file disclosures consume safe visible counts and the [canonical metadata index](2026-11-12-page-tool-attachments-by-canonical-producer-revision.md), independently of the ordinary tool result header. Opening a disclosure reads one page of at most 32 raw positions; Next remains reachable when the owning presentation omits every file on that page. Pages replace their displayed window and retain a First action instead of accumulating all rows. Each file uses the returned producer version and exact ordinal for preview and save. Ordinal zero remains distinct from the standalone attachment operation. Invocation changes, source disposal and lost authorization release filenames and active byte previews. Ordinary tool rendering retains its separate bounded header and field-loading behavior; a bodyless file index does not make that entire renderer path bodyless.

Explicit native saves can continue while bytes make progress. They keep cancellation and finite response/chunk idle deadlines instead of the ordinary control operation's total deadline. Empty stream chunks do not renew progress, and the field consumer rejects repeated offsets. An idle deadline aborts the captured transfer owner, allowing the caller to finish even while an uncooperative dependency still holds its response. Publication still requires a verified complete digest and an uncancelled owner.

Organization pages reuse shared controls, fonts, themes and confirmation dialogs. Administrative mutations submit observed revisions. One-time setup, invitation and reset secrets enter through the first-party fragment, are removed from the URL before validation, and remain in component memory only.

## Alternatives considered

**Larger generic JSON IPC limits.** Base64 and complete response buffers multiply retained memory and grant generic control routes unnecessary file-transfer capability.

**Renderer-owned privileged downloads.** Supplying access tokens or a generic filesystem destination lets renderer code select authority beyond the captured organization and native save choice.

**Publish a temporary file before verification.** An incomplete or corrupt download could replace a valid destination and would make cancellation indistinguishable from success.

**Build a file gallery from the complete tool header.** This makes file discovery wait for body preparation and admits a lifetime attachment array before a user opens it. Safe summary counts and independent metadata pages keep that work explicit.

## Consequences

File operations require the strict byte or save protocol while ordinary generated SDK calls keep their existing transport. Real Electron tests cover non-UTF-8 structured-clone bytes, range preservation and cancellation; filesystem tests cover digest failure, temporary cleanup and atomic replacement. Native save dialog interaction remains part of Desktop product acceptance.

Native field tests exercise actual temporary files, UTF-8 bytes across bounded reads, retained partial output, preparation before and during saving, and binding changes during the picker. A short configured control deadline verifies that progressing saves can outlive it while an idle held native response terminates without opening the picker. Attachment tests retain non-UTF-8 bytes through native and remote generated calls, reject another creator before the picker, recheck binding afterward, and preserve an existing file after cancellation, corrupt content or lost evidence. Headless conversation tests verify metadata-only admission, verified text preview, replacement of another preview, the exact target-only Desktop call, unavailable evidence and revocation clearing existing content. Tool file cases open while the ordinary header is still preparing, retain Next through a hidden empty page, verify ordinal zero and a late ordinal, replace page previews, and clear filenames on revocation. Opening Files adds neither ordinary part-header requests nor original-byte reads. These tests inspect narrow light and wide dark layouts alongside the existing conversation suite; they do not establish real OS picker acceptance.
