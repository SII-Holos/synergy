# Decision Record: Preserve SDK native request bodies

Status: implemented

## Problem

Generated publication upload methods accept Blob or File bodies, but their flat parameter mapper does not map an unnamed body field. Its empty-slot cleanup also removes native body objects with no enumerable keys. An upload can therefore send zero bytes while direct HTTP requests work.

## Decision

The existing pinned Hey API dependency patch corrects its authoritative parameter template. An unnamed body field maps to the explicit body parameter, and cleanup removes only empty plain objects. Blob, File, ArrayBuffer, typed arrays, FormData and URLSearchParams retain their native identity. Both SDK outputs are regenerated through the root workflow; generated files receive no handwritten fixes.

The pinned source and adaptation are recorded in the [dependency patch provenance](../../../../patches/README.md#generated-sdk-native-request-bodies). Behavioral tests cover both generated parameter builders and a real HTTP publication upload with non-UTF8 bytes and caller authentication.

## Alternatives considered

**Use a handwritten fetch call for publication uploads.** This would leave the public generated API broken and duplicate authentication and routing in each consumer.

**Patch generated files after every build.** The dependency template already supplies both SDKs, so correcting it gives reproducible output without a second code transformation.

## Consequences

Existing empty plain slot behavior remains intact while native body objects survive mapping. Upgrading the generator requires rerunning the binary transport tests and removing the patch only when upstream preserves the contract.
