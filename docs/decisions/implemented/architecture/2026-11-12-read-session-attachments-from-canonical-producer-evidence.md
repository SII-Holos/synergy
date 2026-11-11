# Decision Record: Read Session attachments from canonical producer evidence

Status: implemented

## Problem

Private attachment headers do not authorize access to a Runtime's global Asset store. Resolving a hash, Asset URL or local path supplied by a reader could expose another Session's bytes. A changed Part can also invalidate the attachment selected before a slow range finishes.

## Decision

Expose bounded attachment bytes through `SessionHistory.attachmentContent`. Resolve the Session's canonical Scope and visible message before reading its Part. Require the current native Part version and its existing Session-owned Rollout artifact reference. The producer already verifies those references before persisting Parts; the reader independently resolves the exact artifact under that same Scope and Session and compares its complete identity, media type, byte count, chunk count, hash and status.

Read at most 64 KiB of binary data per request. Return only a safe filename, media type, exact byte count, checksum, native version and the requested byte window. Recheck the Part version and artifact reference after the awaited byte read. Missing evidence and partial artifacts remain explicitly unavailable. Reads never create missing evidence, resolve an Asset URL or materialize a local filesystem path.

Keep remote authorization outside this native primitive. Organization adapters must retain their creator, lineage, driver and epoch checks; the attachment reader does not grant public or cross-project access. Standalone Attachment Parts and tool attachment catalogs retain separate presentation work, so this native operation does not establish the complete private attachment interface.

## Alternatives considered

**Read a global hash or local URL from the header.** Neither establishes a canonical producer in the requested Session.

**Capture missing attachment bytes on first read.** This turns an unverified historical reference into new evidence and makes a read mutate provenance.

**Trust only the version checked before I/O.** A concurrent Part replacement could publish bytes for a source that the current Part no longer names.

## Consequences

Real temporary Session and Storage fixtures cover non-UTF8 binary ranges, rejection of foreign producer references, corrupted cross-owner references, unavailable partial or missing evidence, and a Part changed both before and during a held byte read. Tests forbid global Asset materialization, read-time attachment capture and full Part hydration. Transport, native saving and tool attachment pagination remain separate consumers.
