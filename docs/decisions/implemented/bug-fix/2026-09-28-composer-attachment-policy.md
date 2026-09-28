# Decision Record: Server-owned preparation for composer uploads

Status: implemented

## Problem

The ordinary composer assigned a model policy to every upload. Its summary policy for non-images was indistinguishable from a caller deliberately excluding a document's contents, so preparation correctly respected it and omitted the uploaded text.

## Decision

The composer submits the managed URL, MIME type, original filename and presentation metadata without selecting a model policy. The server's canonical attachment preparation selects image transport, text decoding and document extraction. Explicit policies supplied by API callers keep their existing meaning.

## Alternatives considered

Duplicating the server's MIME and document rules in the composer would create two independently maintained policy selectors. Unconditionally extracting content on the server would violate deliberate summary and exclusion policies.

## Consequences

Payload regressions cover image, text, JSON, PDF and Office uploads. Product acceptance checks an identifier contained only in bytes uploaded through the actual Desktop composer, and verifies that the completed upload retains the pending card's accessible remove action after a refresh. The [incident record](../../../postmortem/0034-composer-upload-suppressed-content.md) describes the missed cross-layer test.
