# Decision Record: Rebuild Session indexes with the original import writer

Status: implemented

## Problem

Portable Home imports own a real target Store transaction without installing it as the current Runtime's business transaction. Session index rebuilding called the Cortex and child index business writers, which require that ambient transaction. A target can also differ from the Runtime's current Store, so checking the current Store cannot certify the import writer.

## Decision

Session index rebuilding requires the actual target Store and its original live write callback. That Store verifies the transaction before any index removal or publication. Home transfer passes its prepared target Store explicitly; current-Home migrations pass their actual current Store.

Cortex and child index owners expose narrow derived-index rebuild operations. They verify the same Store transaction and reuse their ordinary codecs and row writers against canonical Sessions read from that transaction. Cortex completion pages headers in batches of 128. Ordinary lifecycle mutations retain their existing business transaction and transfer guards. Rebuilding indexes creates no Session, execution or transfer authority.

## Alternatives considered

**Use the current Store or install an artificial business frame.** A portable target may be a different prepared Store. An ambient frame could read the source's transfer state or publish effects outside the original import callback.

**Accept a transaction without its owning Store.** A real transaction from another namespace does not prove that it belongs to the intended target. The actual Store's private live-callback check supplies that proof.

**Duplicate index serialization in the importer.** That would separate hidden-child filtering, counts and ordering from their existing owners. Reusing the index owners keeps ordinary and imported reads consistent.

## Consequences

Canonical imports and derived indexes commit or roll back together. There is no persisted-format change or new migration path. The [native regression](../../../../packages/harness/test/session/storage-indexes-portable.test.ts) exercises real portable import, Cortex visibility, rollback and a mismatched Store writer. Existing Session index and Home transfer tests retain their original behavior. See [the postmortem](../../../postmortem/0195-portable-index-rebuild-used-the-ambient-writer.md).
