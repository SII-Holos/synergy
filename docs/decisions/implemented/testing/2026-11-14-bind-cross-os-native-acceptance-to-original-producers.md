# Decision Record: Bind cross-OS native acceptance to original producers

Status: implemented

## Problem

A same-platform handoff fixture cannot establish that retained native files and history survive a physical OS change. An Actions run's advertised head does not prove that its native asset job checked out that same source. A temporary public fixture endpoint also needs an actual streamed-body limit before parsing untrusted JSON.

## Decision

The supplementary workflow runs a real Darwin member and Linux member against one actual organization Service. It transfers the same Session to Linux and back to Darwin, retaining paused activation, original history and Snapshot bytes, dirty and untracked files, binary data, symlinks and independent Continue at each destination. Each peer verifies its real platform and native descriptor. The finite rendezvous uses signed ephemeral peers and verified TLS; uploaded evidence contains only public keys, sealed bootstrap data and sanitized result facts.

Native asset producers explicitly check out the PR source head, or the triggering commit for other events. The cross-OS consumer binds the successful original run, artifact identity and verified asset bytes to that same source head. Required repository CI separately records its tested merge revision. The fixture counts streamed request and response bytes within its original 1 MiB limit before JSON decoding and signature checks, cancels an oversized body and releases its reader. Runner-local diagnostics begin before the peer imports and name only its public run identity, finite setup phase and safe error codes. Certificate exit and tunnel readiness stay separate phases; diagnostics never publish private logs, endpoints or keys and do not replace actual roundtrip acceptance.

## Alternatives considered

**Use two directories or a platform label in one process.** Neither exercises native filesystem behavior on another physical OS.

**Accept Actions run metadata as source proof.** Default PR checkout can use a merge revision; the original producer checkout must establish the source it actually built. This follows the [official checkout guidance](https://github.com/actions/checkout#checkout-pull-request-head-commit-instead-of-merge-commit).

**Trust Content-Length or parse before enforcing the body budget.** Missing or incorrect headers can permit allocation and parsing beyond the intended bound.

## Consequences

The workflow adds a bounded two-runner joint acceptance beside existing platform suites. Real two-OS success remains separate from local unit, type and workflow validation. Missing same-head assets or an unavailable rendezvous fails preparation within its existing finite budget; an infrastructure retry retains the same source revision and original asset provenance. Windows and Hosted-specific behavior retain their own original acceptance.
