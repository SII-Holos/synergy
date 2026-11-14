# Decision Record: Observe original transport phases in acceptance tests

Status: implemented

## Problem

Transport fixtures can assert the wrong phase when a short whole-request timer expires during native admission, a heartbeat replies before its presence writer drains, or an unqualified fault reaches another transaction. GC observations can also retain the target they are measuring. A passing error category or a cleared journal alone cannot establish the intended behavior.

## Decision

The lost-command-receipt fixture records the real peer's original input and accepted B before cancelling its caller observation. It then requires unknown delivery, reconciliation of the same accepted receipt, exactly one input and immutable-payload conflict. Native dropped/throwing sends use the existing standard forwarder and still require exactly one real send attempt. The separate backpressure timeout case retains its original timer and late-receipt assertions; product deadlines are unchanged.

The partial-blob bounds fixture waits for the original socket's pending callback after each heartbeat before submitting its next fragment. The echo establishes liveness while that writer may remain charged. Original group count, decoded bytes, fragment sequence, domain non-admission and transport limits remain asserted. Unexpected closure includes its integer close code. The original schedule reproduced code 1013 before this barrier was added.

Retirement fault injection uses a test-local context around only the valid original retirement commit, after the copied-lease and wrong-reference controls. The before/after SQL cases retain the exact injected error, native acceptance, canonical reservation, observer and cold-completion assertions. Native rejection results settle before synchronous identity assertions; unexpected success remains a failure. The original local baseline passed, so this change does not establish the cause of the earlier remote matcher failure or modify product reconciliation.

The Blueprint control-migration rollback fixture injects its original failure after the actual target display Part's native bulk write has staged in the original Store. It verifies that canonical message and Part requirements are visible inside that transaction before throwing, then requires one fault, the same error, unchanged canonical/display/Inbox rows, an absent migration receipt and a successful public retry. An obsolete single-record API spy cannot demonstrate rollback after publication moves to the native bulk writer.

The idle sequencer test crosses native callback jobs between GC and the next weak sample. The original target, expiry, idle interval, one-second collection guard and assertions remain unchanged. [WeakRefDeref](https://tc39.es/ecma262/multipage/managing-memory.html#sec-weakrefderef) keeps a returned target alive during the current execution; the observer must allow the host to release it. A negative control that disables only idle cleanup still fails with the retained journal entry. The original remote journal was already empty, so this fixture correction is not evidence of a production leak or its repair.

The cross-OS fixture retains the first four original header failures, up to two cause links, sixteen named error categories and four relevant original tunnel diagnostics. Text passes the canonical explicit redactor and URL/path/IP removal before the final 512-character bound. Error property reads use descriptors without invoking accessors. Proxy and CA facts retain key presence only. No requests, probes, retries, TLS changes or deadline changes are added. The public-health failure remains unattributed until an actual run supplies that evidence.

The original tunnel readiness promise requires both its captured public URL and the first registered connection; registration does not establish public DNS availability. Passive Bun DNS statistics retain only six numeric counters before the first request, during the first four original failures and at final failure. Getter errors cannot replace the original health error. Native-asset preparation has a separate finite ten-minute consumer window and eleven-minute outer guard, covering the observed cold producer rather than changing any peer-health or business deadline. Exact-head, successful-workflow and artifact-identity checks remain required.

Native stdin fixtures require both their actual running state and original readiness output. A real admission-lease release barrier reproduces readiness output arriving while publication is still accepted; the original running guard and operation lifetime remain unchanged. Additional-Workspace failures retain only the original baseline and Git-operation stages through fixture-qualified passthrough observations. Cold preparation snapshots reuse the original predicate reads and report when that snapshot was observed. These diagnostics do not establish the cause of an earlier platform timeout.

Original Workspace and consented-handoff fixtures retain bounded stage metadata for native body completion, member/service closure and the original active drive. Receipt observations match the same request and Runtime and retain states and proof purposes only; first-heartbeat readiness is diagnostic, not authorization. Original errors propagate, all cleanup ordering remains intact, and no missing receipt is interpreted as accepted work. Native Source expiration and other final authority guards still apply during inspection.

Normal Handoff completion issues one mutation and observes only fresh inspection requests after a working or unknown response. Completion requires the original full binding, expected terminal purpose, proof hash and enrolled participant signature. Each return leg supplies its own binding and reversed participants. Explicit lost-reply, rejection and held-operation controls retain raw calls. Composite consented return cases use a ninety-second whole-case guard; native observers, CLI requests, proof expiry and intentional fault barriers retain their individual limits. A dropped actual machine receipt must recover the same signed fact without another preparation call.

## Alternatives considered

**Increase product deadlines or transport limits.** That would change supported behavior while leaving phase-sensitive assertions ambiguous.

**Use heartbeat echo as data completion.** Independent heartbeat progress deliberately precedes pending storage settlement.

**Accept a failure without proving the native branch or injected owner was reached.** The same category can result from admission ending before transmission or from unrelated work.

**Increase GC sleeps or change sequencer cleanup after observing an empty journal.** Neither identifies the target's remaining root or removes observer retention.

## Consequences

Tests exercise their named protocol phase while preserving native execution, original receipts, error identity and workload bounds. Bounded diagnostics explain future failures without retaining bodies, credentials or raw environment values. Exact-head CI, complete coverage contribution and actual cross-platform execution remain separate requirements; local success and diagnostic union are not substitutes.
