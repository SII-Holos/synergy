# Decision Record: Retain portable reader cancellation and ports

Status: implemented

## Problem

The portable reader retained its caller's mutable input object. Clearing its signal after opening let an originally cancelled read finish. Cancellation while a blob read awaited also allowed returned bytes to reach the consumer before the next check. Mutating the reader's public root could replace the original package with an empty verified package.

## Decision

The reader snapshots the original signal, freezes its validated root and binds the original blob provider methods before opening its private index. One local guard checks cancellation and closure before and after asynchronous page and content reads, before yielding or updating the index, and before declaring verification complete. Cleanup still closes the original private index independently of cancellation.

## Alternatives considered

**Rely only on enclosing transfer contexts.** The codec is also a public leaf for trusted portability owners and must preserve its own input and reader lifetime.

**Check only before awaiting bytes.** The original signal can expire while the provider resolves; no cancelled result should be returned afterward.

## Consequences

The stream format, verification totals, single-use iteration and execution boundaries remain unchanged. A cancelled or closed reader cannot yield a late chunk or declare a complete package. This does not add transfer, publication or execution authority.

## Verification

`test/session/transfer-stream.test.ts` reproduced cleared-signal acceptance, late-chunk delivery and public-root replacement before their fixes. It preserves complete byte/checksum validation and more than the former total object quota. See [the incident](../../../postmortem/0114-portable-reader-forgot-original-cancellation.md).
