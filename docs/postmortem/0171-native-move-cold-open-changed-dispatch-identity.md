# Native Move cold open changed dispatch identity

## Executive summary

A retained native WorkspaceMove claim could not be reconciled after closing and reopening the same enrolled Home. Its dispatch ID hashed storage open options, so Bootstrap importing with `mustExist: false` and reopening with `mustExist: true` selected different IDs for the same dataset. Physical ownership needs a stable dataset identity rather than connection flags.

## Summary

The real account-removed target cleanup regression prepared an actual native destination, cancelled its source, closed the member Runtime and reopened its original Home. Ordinary connection and Session authority remained correctly denied. Dedicated recovery reached the original Target but native release rejected the retained claim ID. The physical claim and original receipt were preserved; cleanup did not converge.

## Timeline

Warm revoked-device cleanup succeeded. The cold account-removed case exposed the storage-option mismatch. After binding dispatch to the Bootstrap dataset selector and existing store/artifact UUIDs, the same cold case passed with its original Epoch, Move and coordinator claim, without restoring ordinary authority or allocating compute.

## Root cause

The ID included the entire `StoreOptions` object. Open-time existence, recovery and read-only flags are not dataset identity. Conversely, a filename or namespace alone cannot distinguish a newly created database from the dataset that owns an old durable claim.

## Guardrails

New Move records anchor the canonical Bootstrap selector, existing dataset UUIDs, original Home and artifact owner before native dispatch. Physical effects require the actual writable primary Store. Owning record migration marks historical intents explicitly; only those intents may inspect a bounded set of known historical open-flag aliases, while retaining the original reference and claim token. Fresh intents never scan historical aliases. Missing or changed dataset identity fails closed.

Catalog volume identities and coordinator admission identities have separate native encodings. Capture validates both through their owners. Original claim release checks its actual ledger root, Host and token without comparing the two encodings or inspecting a replacement directory. Historical four- and seven-field references retain their original JSON and receipt hashes.

The actual enrolled-Home cold test covers Bootstrap importing-to-ready reopen and cleanup after account removal. `test/workspace/native-adoption.test.ts` verifies original four-field references and tokens across capture and lost release acknowledgements, bounded legacy alias ambiguity, foreign and read-only Handles, and a fresh database at the same Home and filename that cannot acquire or release the previous dataset's claim.

## Lessons

A connection's opening policy is not a persistent namespace identifier. Cleanup must retain both original physical evidence and the dataset identity that is allowed to use it. See [original cleanup ownership](../decisions/implemented/architecture/2026-11-13-own-revoked-target-cleanup-through-original-handoff-evidence.md).
