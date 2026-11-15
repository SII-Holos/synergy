# Decision Record: Bound SQLite telemetry fingerprint reuse

Status: implemented

## Problem

Each native SQLite request normalizes and hashes its SQL text for a duration label, before the existing metric sampler decides whether to persist it. An original six-thousand-message diagnostic observed 1,014 of 25,457 sampler traces at this expression. Those samples do not measure independent SQLite execution, all cryptographic hashing, or a guaranteed capacity improvement.

## Decision

Reuse only that pure SQL-text telemetry derivative inside its original worker client. Exact original text keys map to the same normalized SHA-256 prefix. A client retains at most 128 entries and 128 KiB of UTF-16 key/digest payload; oversized statements are not retained. LRU removal and every original terminal close path bound the lifetime. Keys may contain inline SQL literals, so the memo stays private RAM and never enters logs, metrics, persistence or exported diagnostics.

Every native query, parameter, result, current owner guard and error still runs through the original path. Metric forwarding, sampling, slow/error selection and captured Runtime context are unchanged. This is not an authority, SQL result, schema, migration or prepared-statement cache.

## Alternatives considered

**Sample before computing the fingerprint.** The existing metric forwarder precedes configuration and random sampling. Pre-sampling at the SQL caller would change forwarding and random-selection behavior; there is no existing lazy label factory that preserves these semantics.

**Retain fingerprints globally or without a payload bound.** SQL text can contain private literals and large comments. A process-wide memo would outlive the client and mix ownership, while an entry-only bound would allow unbounded text payload. The private client memo keeps both entry and UTF-16 payload limits.

## Consequences

Repeated exact SQL text can avoid normalization and hashing while retaining the original telemetry value. Eviction and oversized text only repeat the original computation. The 128 KiB bound counts logical UTF-16 key/digest payload, not process RSS; the 128-entry cap separately bounds entry metadata. Raw SQL can remain in bounded private RAM until eviction or client termination and is cleared on the original terminal paths.

The sampled expression accounts for 1,014 observed traces, not every cryptographic operation. Hit rate, total CPU savings and a full capacity improvement remain unmeasured. A focused work-bound check alone cannot establish a full capacity deadline or process memory result.

## Validation

Qualify the original redundant-work failure through two real queries with identical text and different values, preserving fresh rows and original forwarded labels. Exercise separate clients, entry and byte eviction, oversized statements, privacy, errors and original worker close/deadline controls. A focused work bound cannot establish a full capacity deadline or memory result.
