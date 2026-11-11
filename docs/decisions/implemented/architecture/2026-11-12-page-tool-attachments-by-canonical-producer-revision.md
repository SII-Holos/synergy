# Decision Record: Page tool attachments by canonical producer revision

Status: implemented

## Problem

A completed native tool may retain more attachment entries than a reading window can hold. Slicing its embedded array after reading the complete Part makes every page and byte request decode the entire producer. Copying a derived index during transfer also carries SQL revision identities that do not identify the target's canonical Part.

## Decision

The Session owner maintains an attachment metadata header and ordinal rows in the same transaction as `PartContent.replace()`. The index retains the canonical Part's SQL revision, exact artifact references and safe file metadata. It grants no global Asset access. Display refreshes cannot establish producer evidence because they do not write the canonical Part.

`SessionHistory.attachmentPage()` validates the visible message and reads at most 32 rows through the native index. Its cursor binds the exact producer key, revision and position. The page's opaque version fixes subsequent ordinal byte reads; changing the canonical Part rejects an old cursor or byte version. Metadata and byte reads check canonical revisions without decoding the tool Part. Missing or inconsistent index rows fail instead of reporting a truncated complete list.

The central Session migration builds indexes for historical producers. It reads each old Part during that owning upgrade, preserves its canonical body and writes a completion receipt. Later pages and restarted readers use only current metadata rows and revision reads. New producer replacement rolls back the canonical Part and its index together.

Ordinal byte reads reuse the Session's Rollout artifact owner, bounded range reader, exact reference validation and post-I/O checks. A foreign artifact, absent evidence or partial original cannot become a downloadable file. Standalone attachment reads retain their existing native field version and omit the ordinal.

Portable Core exports exclude these derived rows, and target validation rejects an injected raw index. During activation the target discards its obsolete index rows and builds current metadata beside each mapped canonical Part write. It does not adopt source SQL revisions or use an index as execution authority. Original canonical Parts, unknown retained fields and artifact evidence keep their established portability owners.

## Alternatives considered

**Read and slice the stored attachment array.** Every page retains the complete Part and makes a small metadata request grow with the lifetime file count.

**Create a second global hash authorization table.** Existing canonical producer admission and Session-owned Rollout evidence already identify the permitted bytes. Another table would compete with those owners.

**Copy derived rows with portable Core.** Target SQL revisions differ, so copied metadata either becomes unusable or requires weakening current producer checks.

## Consequences

The index adds metadata writes to canonical Part replacement and a one-time owning upgrade for old records. Native page limits bound residency without limiting the number of files a tool can retain. They do not establish the organization wire API, renderer gallery or OS saving acceptance.

Real storage tests enumerate 1,001 files, read the final ordinal and forbid any canonical Part body read during steady paging and byte access. Additional cases cover producer replacement during a held range, foreign cursors/artifacts, cancellation, publication rollback, missing metadata, central migration and restart. The two-Home Core fixture excludes source indexes, changes the target Part revision inside its authorized activation, rejects injected index records and reads the target's original binary evidence afterward.

## Related

- [Canonical attachment evidence](2026-11-12-read-session-attachments-from-canonical-producer-evidence.md)
- [Session messages](../../../architecture/session-and-messages.md#assets-and-attachments)
