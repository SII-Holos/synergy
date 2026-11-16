# Decision Record: Validate canonical native output before portable publication

Status: implemented

## Problem

A completed Environment transfer could carry a fully authenticated output frame whose data was invalid or noncanonical Base64. The native output schema accepted any bounded string, while consumers decoded it permissively. The portable reader also retained shared Buffer views, so a producer could change already yielded bytes before validation completed. See [the postmortem](../../../postmortem/0143-portable-environment-output-accepted-invalid-frames.md).

## Decision

The canonical `ExecutionProtocol.Chunk` schema owns Base64 validation. A payload must retain the existing size bound and equal the result of decoding and encoding it back to Base64. This rejects invalid characters, whitespace, omitted or excessive padding and nonzero pad bits. Empty output and canonical binary payloads remain valid. Oversized strings reject before decoding in the refinement.

The portable reader copies every yielded chunk with `Uint8Array.from()`. After UTF-8, JSON, native frame and cursor validation, it returns the original concatenated JSON bytes. Validation does not normalize the stored frame, discard unknown frame fields or change its serialization. Artifact checksum and cursor coverage checks remain with their existing owners.

## Alternatives considered

**Trust package authentication and cursor completeness.** They prove the supplied bytes and addresses, not that a frame contains valid native output.

**Validate only in the portable reader.** Live native and remote output readers share `ExecutionProtocol.Chunk`; a separate portability rule would leave the canonical protocol permissive.

**Decode and rewrite each frame.** Rewriting would change authenticated historical bytes and discard serialization or extension data. A round trip validates the payload without replacing the original JSON representation.

**Assume a yielded typed array owns its storage.** Buffer subclasses may expose shared views. Taking a concrete independent byte copy makes the public iterable contract safe without changing ArtifactPack behavior.

## Consequences

Malformed historical output now rejects through the existing native frame readers and blocks portable publication. This is validation of the unchanged wire and storage format; it does not migrate or repair corrupt output, grant current allocation authority or recover bytes previously declared truncated by the native owner.

Harness regressions cover malformed encodings, canonical empty/binary values, original JSON bytes and a reusable Buffer iterator. The real Local Runtime execution transfer fixture rebuilds complete package hashes around malformed and noncanonical output and verifies rejection before native publication. Existing rollback and cold reads continue through the same owners.
