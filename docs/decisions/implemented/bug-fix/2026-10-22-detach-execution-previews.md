# Decision Record: Detach execution previews from source text

Status: implemented

## Problem

Execution nodes retain short titles and previews in Runtime-owned presentation caches. Collapsing whitespace across a complete message and then slicing the result can leave a short JavaScriptCore substring sharing a large backing string. A task-count limit does not bound that hidden retained content, and complete-message normalization also allocates work unrelated to the visible preview.

An isolated Bun 1.4.3 reproduction retains 32 large source strings through only 7,680 preview characters after synchronous full collection. The regression exceeds a generous 4 MiB retained-external-memory allowance with the original expression. This establishes a source-retention mechanism, not the fraction of an existing backend's memory attributable to it.

## Decision

[Execution previews](../../../../packages/workbench/src/execution/preview.ts) collect at most 240 normalized UTF-16 code units and construct their result from those numeric values. They collapse ECMAScript whitespace exactly as the existing display expression does, preserve leading and trailing collapsed whitespace, and retain code-unit truncation including a boundary inside a surrogate pair. Collection stops when the preview is complete instead of normalizing the remaining message. The returned string cannot retain its input through substring backing storage.

All execution-node preview producers use that implementation. Canonical message content, node identities, query schemas, cache capacity and lifetime, provider execution, persistence and GC policy remain unchanged. No production heap sampler, diagnostic endpoint or forced collection is added.

## Alternatives considered

**Copy an already normalized and sliced preview.** A UTF-16-preserving copy can detach its backing storage, but the complete message is still normalized and allocated before truncation. Building only the normalized preview avoids that work and the retention mechanism together.

**Encode the preview through UTF-8.** This detaches storage but replaces unpaired surrogate code units, including those produced by the existing truncation boundary. Explicit code-unit construction preserves the display contract without encoding repair.

**Increase GC frequency or shorten cache lifetime.** Collection cannot release backing storage while a live preview still references it. Cache-policy changes also alter refresh and reuse behavior without correcting the preview itself.

## Consequences

Preview storage and construction are bounded by the displayed code units rather than the source's byte length. Long whitespace runs can still require scanning additional input to produce the same collapsed result. Task metadata and other execution-cache allocations retain their existing lifecycle and are not claimed to be globally byte-bounded by this fix.

[Preview regressions](../../../../packages/workbench/test/execution/preview.test.ts) preserve whitespace and UTF-16 semantics and run Latin and two-byte source-retention checks in fresh Bun subprocesses. Each child uses synchronous full GC and keeps the previews live across the measurement; it imports no Runtime and opens no user Home. The memory assertion is a broad accumulation bound, not an RSS or timing target. [Route coverage](../../../../packages/workbench/test/execution/routes.test.ts) checks the real execution projection and verifies original message text remains intact. Existing [failed-buffer regressions](../../../../packages/harness/test/session/part-write-buffer.test.ts) verify the separately implemented retained-failure accounting; that fix is not reintroduced here.
