# Native materialization replaced a competing directory

## Executive summary

Native tree materialization checked the destination, then used an ordinary rename. A directory created after that check could be replaced even though its identity belonged to another preparation. Both native materializers now reuse the canonical no-replace publisher, and pending FileHost retries require their original prepared directory identity.

## Summary

An isolated paged FileHost fixture inserted a real empty destination immediately before the real publication rename. The old path resolved successfully and replaced the competing directory. The regression now requires publication to fail while that directory's inode, empty contents and absent completed mount receipt remain unchanged.

A second real barrier replaced the directory after the successful native rename but before the publisher returned. The host also accepted that replacement because it recorded the newly observed physical identity rather than comparing it with the original prepared identity. Its final receipt check now rejects this substitution too.

Root review reproduced a third gap in both codecs: a replacement introduced immediately before removal of a previously empty destination was deleted, after which even exclusive publication succeeded. Both materializers now require an absent destination and never retire an existing directory. Producers already select private absent targets; corrupt-content and cancellation fixtures exercise those targets directly.

## Timeline

1. The consumer verified the complete immutable graph and synchronized its private staged files.
2. Its final destination check observed no directory.
3. The controlled publication barrier created a competing empty directory before the actual rename.
4. Ordinary rename replaced it and returned a successful mount.
5. The same barrier against `FileRename.exclusive` rejects without replacing the competing native object.

## Root cause

A prior path observation did not make a later overwriting rename exclusive. Content verification also could not establish that an existing final directory came from the current request after an uncertain acknowledgement.

## Guardrails

- [x] Machine check: `test/workspace/file-host-paged.test.ts` inserts an empty destination after the last identity check and verifies unchanged physical identity after rejection.
- [x] Machine check: the same suite replaces the actual newly published directory before the publisher returns and verifies that no completed receipt adopts it.
- [x] Machine check: the same suite reconciles an actual lost publication acknowledgement only for the original prepared directory, rejects equal-content replacement and preserves pending legacy receipts without preparation evidence.
- [x] Procedure: both legacy and paged materializers use the existing platform-native no-replace publisher, with no overwriting fallback.
- [x] Machine check: the same suite preserves an existing empty destination's inode and rejects before any removal; its original removal barrier reproduced the foreign-directory deletion in both codecs.

## Lessons

Verify the published native identity as well as the immutable content. A checked path is an observation, not an exclusive publisher. A reported error after a real rename is an unknown acknowledgement that requires its original receipt. See the [FileHost decision](../decisions/implemented/architecture/2026-11-12-materialize-paged-heads-through-native-file-host.md).
