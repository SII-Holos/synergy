# Decision Record: Isolate benchmark image ownership across cache roots

Status: implemented

## Problem

Task and inference-proxy image tags used content identities while their ownership receipts and collection locks lived inside a cache directory. Two independent caches on one Docker daemon therefore selected the same image tag. The second cache correctly rejected the unowned image, preventing restricted-network task preparation. Adopting the tag would instead let one cache collect an image still referenced by another.

## Decision

Task and inference-proxy image identities include a digest of the resolved cache root. Tags, labels, receipts and run references derive from that identity. Independent roots receive separate tags; aliases of one physical root retain warm reuse. Existing image ownership checks remain mandatory, and no existing shared tag is adopted or removed to recover preparation. The image build recipes, native task inputs, grading and model profiles are unchanged.

Evaluator changes require a newly frozen experiment. Historical runs retain their frozen evaluator and original cache location. Moving a cache is an explicit new preparation, not an implicit ownership migration. The implementation remains in the benchmark extension of pinned Pier; upstream lifecycle attribution is preserved in its existing source marker and NOTICE.

## Alternatives considered

**Import an unowned tag.** A content label alone does not establish this cache's right to collect the image, and the originating receipt may be unavailable. Automatic adoption would weaken the existing ownership check.

**Delete or overwrite the colliding image.** Another experiment may still reference it. Removing shared state is unnecessary when cache-specific tags provide isolation.

**Use a global receipt registry.** A daemon-wide registry could permit cross-cache ownership and collection, but requires a broader lifecycle and locking design. Independent cache namespaces fix the observed failure without that new shared state.

## Consequences

Multiple caches can prepare the same native task and proxy without claiming each other's tags. Docker can reuse identical content layers, although tags and ownership records are separate. Resolved paths make aliases stable but deliberately make relocation a new identity. Regression coverage checks distinct task and proxy tags across roots, warm reuse, path aliases, missing frozen images and interrupted publication recovery.
