# Independent DNS prerequisite blocked original HTTPS readiness

## Executive summary

The CrossOS fixture made a positive answer from an independent raw Resolver necessary before ordinary HTTPS could run. That Resolver is a different owner from the transport being accepted. Remove the prerequisite and retain the original HTTPS status, run-identity and body checks within the same bootstrap window. Preserve the original failures and failure-only DNS diagnostics.

## Summary

Two attempts of CrossOS run 43801167834 at revision `51bac8b2df8933744f09bec2637720e46c590d84` failed in `darwin-public-dns-readiness`. Attempt 1 completed 443 A/AAAA pairs and attempt 2 completed 449; every original family invocation returned `ENOTFOUND`. Both reports record zero ordinary health requests and zero origin-handled requests, cancellation returned and the owned pair drained. The Linux peer did not reach the Darwin rendezvous. These facts prove that the prerequisite prevented transport observation; they do not prove the public HTTPS route would have succeeded.

## Timeline

- The [earlier pending-sibling incident](0218-dns-positive-waited-for-pending-sibling.md) qualified a local ordering defect in that prerequisite. Its real DNS controls did not establish equivalence with ordinary HTTPS readiness.
- Both original attempts at the same revision exhausted the shared bootstrap signal at the independent prerequisite. Their original reports and failures remain unchanged.
- The correction removes the prerequisite and dead ordering controls while preserving the complete original HTTPS callback and the failure-only DNS observer byte for byte. It retains the 120-second bootstrap allowance, five-second request observer and every later business and cleanup check.
- The complete local control file passed 12 cases and 147 assertions, including real task-owned UDP denial and trusted same-hostname HTTPS, exact run-mismatch refusal and original abort identity. This refutes the prerequisite assumption; it is not a local execution of the old public caller. New exact-head public CrossOS acceptance remains pending.

## Root cause

The fixture promoted an independent Resolver result into a necessary condition for another transport. Pinned Bun documents different DNS backends, and a task-specific raw authority can disagree with the ordinary hostname route. A negative result from that authority cannot decide whether original HTTPS is ready. The original health callback already validates its own status, body and run identity.

This finding does not identify an operating-system negative cache, upstream nonpublication, public address-family failure or the cause of the older approximately 83-second error transition. Removing the prerequisite restores observation of the intended route; only a new actual run can accept that route and the later native handoff.

## Subsequent transport evidence

The two actual HTTPS attempts at revision `42fb7bb78bf5dcb9b8bf9414f2281f5d0bc20702` issued 3585 and 3697 original fetch calls, respectively. Every call failed with `ENOTFOUND`, without response headers or an origin-handled request. Passive Bun counters recorded the same number of cache misses and errors, with no completed or in-flight hits. The independent DNS observations obtained positive answers only after the original failure; those non-simultaneous answers cannot explain the earlier window or establish a cache owner. Both original cleanup sequences completed. No additional identical retry is treated as a repair.

Failure-only comparison preserves that original failed result and its counters before any additional request. It compares the current Bun process, a fresh minimal Bun CLI, system curl and a pinned, fresh diagnostic child requesting Bun's libc miss path. Only that last child's environment changes; it is labeled as a requested flag, not an attested backend or production fallback. All clients share OS DNS state and their start times differ, so their late-window observations cannot establish the cause of the original 120-second failure. Original cleanup precedes the diagnostic children’s final join, with truthful pending checkpoints before either join can stall.

The complete local control file passed 15 cases and 201 assertions. Injected Responses qualify identity, bounded data and safe exception handling; real child processes with data URLs qualify program serialization, child-only flag values and pipe drainage. These controls do not constitute a public HTTPS comparison or dynamic proof of the outer failure path. Current-head public business acceptance remains separate.

## Guardrails

- [x] Machine check: `packages/organization-runtime/test/cross-os-control.test.ts` — real independent A/AAAA `ENOTFOUND` for the same hostname whose trusted ordinary HTTPS health succeeds, with run-mismatch refusal and original abort identity.
- [x] Machine check: the same file — retained failure-only diagnostic, redaction, bounded cancellation and observation controls after removal of the prerequisite.
- [ ] Machine check: new exact-head actual Darwin/Linux CrossOS workflow — original HTTPS, authenticated WSS, complete bidirectional native work and cleanup.
- The [original HTTPS readiness decision](../decisions/implemented/testing/2026-11-16-qualify-cross-os-readiness-through-original-https.md) owns current behavior. The [archived prerequisite decision](../decisions/archived/testing/2026-11-15-qualify-temporary-tunnel-dns-within-bootstrap.md) and its historical control results remain sealed.

## Lessons

Let the actual transport establish its own readiness. Independent diagnostics can explain a failed observation, but cannot replace it or veto it without an established requirement. Keep local controlled evidence separate from public-route acceptance and preserve the original failure when a diagnostic or cleanup also fails.
