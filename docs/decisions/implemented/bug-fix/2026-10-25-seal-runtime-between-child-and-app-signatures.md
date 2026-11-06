# Decision Record: Seal runtime bytes between child and app signatures

Status: implemented

## Problem

macOS signing mutates native runtime files after the installation generation and outer distribution inventory have been created. An app can pass native signature verification while its bundled seed fails integrity checks. Rewriting either inventory after the final app signature instead invalidates the signed application.

## Decision

Desktop uses Electron Builder's public custom macOS signing hook and delegates to the upstream signer. Its per-file callback reseals the installation generation and then the outer runtime inventory immediately before the top-level app is signed, after all child signatures. The existing identity, entitlements, hardened-runtime settings and notarization path remain unchanged.

Only paths actually selected for native signing may have changed content hashes. File membership, links, generation metadata, unsigned resources and both original inventories are checked before resealing. Desktop package metadata is included in the outer inventory. Final verification is read-only.

The root dependency override selects the published CommonJS `isbinaryfile@5.0.7`, already used by Electron Builder, for the signer as well. Its upstream [bounded-reader fix](https://github.com/gjtorikian/isBinaryFile/commit/d39d2c0d80014e387a5c906ff3ed6d0b53bdbe2e) and [UTF-8 boundary fix](https://github.com/gjtorikian/isBinaryFile/commit/4832a7c129cbc218a8281ca6d00e87ff899ab616) prevent unbounded allocation when text is misread as protobuf. The detector keeps the signer's existing API and requires Node 18 or newer. The override changes no other resolved dependency or lockfile format and must be reassessed when the signer updates its dependency.

## Alternatives considered

**Rewrite inventories in `afterSign`.** This changes resources already protected by the app signature.

**Skip native signatures or relax seed verification.** Either approach removes a release integrity guarantee instead of reconciling the two representations of the same final bytes.

**Fork the signer or re-sign the whole app afterward.** The public callback supplies the required ordering without a private signing implementation or a second mutation pass.

## Consequences

Native regression fixtures exercise the real signer and the actual installation seed reader, including tampering and signing failures. Full app packaging remains necessary because dependency file inspection can fail on resources absent from small fixtures. Ad-hoc local signing proves ordering and integrity, not Developer ID trust or notarization. The [release runbook](../../../operations/desktop-release.md) owns final artifact checks.

The exact 861-byte compiled branding text is retained as a regression payload. Detection runs through the signer's actual dependency chain in a bounded Node child, and the same payload participates in native signing. The test cannot accidentally pass by importing Electron Builder's already-correct detector instead of the signer's copy.
