# Workspace readers outlived their selected storage

## Executive summary

Selected object reads did not understand paged saved heads. While integrating the canonical index, behavioral tests also found namespace substitution, callback completion before accepted body I/O drained, and safe-integer overflow beyond EOF. One callback owner now binds the actual read lifetime and clips ranges before arithmetic.

## Summary

All counterexamples used isolated temporary Storage and content. A real selected paged head failed ordinary file browsing. After the indexed path existed, changing the same Store's namespace still admitted metadata reads. Another test returned from the callback while a real underlying blob read waited; the callback completed before that accepted I/O. A valid maximum safe offset plus a small length threw instead of returning an empty range.

## Timeline

1. A multi-page object Workspace reproduced failure in the ordinary content API, and a selected Local Runtime FileView reproduced the same array-only assumption.
2. The shared callback reader connected both product entry points to the canonical portable index.
3. Original-signal and escaped-callback cases passed, but changing the actual Store namespace reproduced acceptance. Binding Store options and primary/artifact identity closed it.
4. A genuinely held body read outlived callback completion. Tracking accepted underlying reads and draining them before disposal closed the lifecycle hole while retiring their late results.
5. The maximum-safe offset reproduced overflow in the indexed range path. Clipping both indexed and historical ranges before addition produced empty output with no body read.

## Root cause

Format support and asynchronous read ownership were split across product entry points. Object identity alone did not freeze mutable Store options, and index disposal did not account for already accepted I/O. Range arithmetic validated operands but added them before constraining the result to file size.

## Guardrails

- [x] Machine check: `packages/harness/test/workspace/content-paged.test.ts` verifies paged product reads, concrete namespace/artifact/Runtime identity, original cancellation, closed readers and accepted body drainage.
- [x] Machine check: the same suite and `test/workspace/content.test.ts` verify beyond-EOF ranges without body reads and representation-independent entry versions.
- [x] Machine check: `packages/local-runtime/test/workspace-file/paged-view.test.ts` exercises actual selected resources, metadata-only browsing, complete/range reads, observation and revalidation without compute.

The [decision](../decisions/implemented/architecture/2026-11-12-read-selected-workspace-files-through-paged-indexes.md) defines the owning read path and remaining producer migration scope.

## Lessons

Bind the entire read lifetime to the actual storage configuration, and wait for accepted I/O before releasing its owner. Validate bounded results before performing arithmetic on valid but extreme inputs.
