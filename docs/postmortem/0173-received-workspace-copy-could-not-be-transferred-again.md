# 0173: A received Workspace copy could not be transferred again

## Executive summary

The first native transfer installed a valid private Workspace inside Runtime data. A later capture rejected that directory through the general Home protection. Protected-path validation needed the original publication and native owners, rather than a broader path exemption.

## Summary

A received copy must remain usable as a later source, including after cold reopening and legitimate file edits. The receiving path and blanket source-path check disagreed about that lifecycle.

## Timeline

- A real two-Home fixture prepared and published the destination through its original transaction and Epoch, then cold reopened it.
- The fixture changed one received file and added an untracked file. The second source capture failed with Runtime data overlap after 18 assertions.
- The owning callbacks enabled current capture while retaining Home, namespace, Scope, physical identity and generation refusals. The final second-hop fixture passed 43 assertions; the three neighboring native-target tests also passed.

## Root cause

The source classifier treated every directory under the Home as unrelated internal data. It did not consult the existing committed publication and permanent target activation. Using only the native preparation receipt or old file hashes would respectively admit unpublished data or reject legal edits.

## Guardrails

- [x] Machine check: `packages/local-runtime/test/workspace/session-workspaces-transfer.test.ts` covers real cold recapture and current dirty/untracked bytes, with primary/Scope/physical/Home/generation negatives.
- [x] Machine check: `packages/local-runtime/test/workspace/portable-target.test.ts` rejects preparation without committed publication.
- Keep physical claims, exclusive access and full capture inside both original owner callbacks.
- See [the decision](../decisions/implemented/bug-fix/2026-11-13-recapture-published-received-workspaces.md).

## Lessons

A protected-path exception must follow the actual data owner. Immutable preparation evidence establishes identity; the current source capture establishes current bytes.
