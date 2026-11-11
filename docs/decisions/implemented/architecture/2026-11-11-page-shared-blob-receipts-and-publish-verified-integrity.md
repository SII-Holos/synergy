# Decision Record: Page shared blob receipts and publish verified integrity

Status: implemented

## Problem

Embedding every chunk in a shared blob header imposed a total chunk limit and repeatedly copied a growing manifest. A complete byte count alone did not prove integrity: publishing the completion flag before verification exposed an inaccurate checkpoint. Read permission also did not establish authority to upload projection content.

## Decision

The sharing owner retains one constant-size v2 header and individual ordered chunk receipts beside canonical Storage binaries. Each accepted nonempty chunk covers its complete aligned range, with at most 4 MiB per request. Exact retries compare existing bytes. A contiguous receipt offset and accepted counters support resumable uploads without materializing the entire list or imposing a lifetime chunk quota.

The owner serializes updates to one blob and verifies its complete receipt order, sizes, total byte count and content hash in bounded windows. Completion becomes visible only through a final authorized transaction. A failed checksum removes that incomplete upload so the creator can retry. Empty content has its exact empty hash and a complete zero-length representation.

Browser uploads require the Session creator. Runtime uploads retain current registered-driver authority. Every upload, status and download checks the current share generation. Download streams recheck access before reading and transmitting each range; an authorized reader cannot turn their read grant into an upload capability.

The central migration converts retained v1 metadata into paged receipts. It preserves original binary objects and does not trust an ambiguous historical completion flag. A current authorized download can reverify complete retained bytes and publish their integrity checkpoint without requiring the source to upload them again.

## Alternatives considered

**Remove only the array limit.** Header copying and memory growth remain proportional to the lifetime chunk count.

**Publish completion at the last receipt.** Receipt presence does not prove the declared content hash.

**Allow any shared reader to upload.** That confuses data access with authority over the creator's projection.

## Consequences

Existing nonempty frames and status remain unchanged; empty content uses exactly one zero-length frame. Real binary tests cover out-of-order delivery, retry conflicts, restart, Range reads, revocation and migration revalidation. A native exporter fixture and real HTTPS/WSS upload verify empty content through the complete transport. A 16,385-receipt fixture verifies the removal of the old metadata cap and a header below one KiB; that fixture is an incomplete upload checkpoint and is not evidence of a real 64 GiB content transfer.
