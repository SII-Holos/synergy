# Publication chunks prepared bytes before qualification

## Executive summary

A publication request for a missing file reached native binary preparation before returning NOT_FOUND. Invalid ranges and conflicting chunk contents followed the same order. Preparation needs a valid current target and absent original receipt, while publication still needs a final transactional recheck.

## Summary

The upload owner correctly kept native I/O outside its SQL transaction and disposed prepared pins. Its initial read checked upload access but omitted the declared file, range, current state and existing chunk receipt. Rejected requests therefore caused avoidable native staging; known receipts also entered the preparation path.

## Timeline

A real Store regression created and sealed a file, reopened the Store, and invoked the native preparation owner while requesting an unknown file. The expected zero preparations failed with one actual preparation. Moving the full qualification ahead of native work made the same case and cold receipt retry pass. Held native preparations then verified that concurrent sealing and author revocation still use the final writer's current state.

## Root cause

Keeping I/O outside a transaction does not mean it should precede all metadata qualification. The earlier implementation used native preparation to reach checks that could already reject or reconcile the request from committed records.

## Guardrails

The shared chunk qualifier runs in the initial snapshot and the final mutation transaction. Rejected targets and matching receipts prepare nothing. A concurrent original receipt prevents duplicate publication; revoked access leaves no canonical artifact reference, and the actual prepared pin is disposed. Existing sealed-content, migration and mounted binary-route tests remain in the same suite. Receipt queries do not replace checksum verification by sealing and content readers.

## Lessons

Qualify native preparation with current immutable target and receipt metadata, then reauthorize the actual publication. Avoidable orphan work is a preparation-order defect, not permission to weaken physical garbage collection.
