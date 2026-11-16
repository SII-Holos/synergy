# DNS positive waited for a pending sibling

## Executive summary

The temporary-tunnel DNS prerequisite waited for both original family queries to settle before acting on a positive answer. A real positive with its sibling held therefore waited for that sibling's native timeout and started HTTP without having cancelled it. Wake on the positive, then cancel and drain the same pair before HTTP, preserving original failures.

## Summary

This is a qualified local readiness-ordering defect, not an identified cause of the public CrossOS failure. The actual 348e CrossOS prerequisite exhausted its shared bootstrap window with zero ordinary HTTP requests and did not retain the original query facts needed to distinguish native query failure, returned records, parsing and cancellation.

## Timeline

- The original 348e CrossOS run reached the DNS prerequisite but started no ordinary public HTTP within the original 120-second bootstrap window. The query-level cause remained unobserved.
- A real task-owned UDP DNS control returned A while the original AAAA query remained held. The unchanged pair-first implementation waited 1002.343 milliseconds, then started HTTP after the sibling's natural timeout. Its Resolver cleanup ran once, but the native cancelled-query count at HTTP was zero where the test required one. This qualified the ordering defect independently of public DNS.
- The corrected helper wakes on either family positive, enters its original cleanup, cancels that Resolver once and awaits the original pair. The two new cases passed 57 assertions, including the symmetric family behavior and original failure ordering.
- Passive original-query facts were added without a new query, timer or second record traversal. The complete control file passed 17 cases and 272 assertions, and the Organization Runtime TypeScript check passed. These results do not accept public CrossOS execution or establish its failure cause.

## Root cause

The readiness decision was downstream of `allSettled`, while the cleanup that could settle a held sibling was downstream of that decision. A valid answer could not initiate cancellation. Waiting for a native timeout made a success path appear clean because no query remained at HTTP, without proving the required cancellation ordering.

The correction races the original pair's settlement against a positive notification and the original abort signal. A positive notification only wakes cleanup: it does not authorize HTTP. Cleanup cancels once, drains the same pair and then rechecks the original signal and both outcomes. Unknown query errors remain the original objects; a cancellation error follows the original failure in the aggregate. No additional query, Resolver override, resolved-address routing or deadline is introduced.

## Historical controls

- Historical machine check (retired with the prerequisite): `packages/organization-runtime/test/cross-os-control.test.ts` — real A and AAAA positives with a held native sibling, exact cancelled-query count and no pending query when HTTP starts.
- Historical machine check (retired with the prerequisite): the same file — unknown query failure, additional cancellation failure, original abort identity, exhausted-window refusal and original HTTP error preservation.
- Historical machine check (retired with the prerequisite): the same file — passive per-family invocation and settlement facts, finite codes, bounded samples, return-kind and valid-IP counts, zero accessor reads and no retained secret values.
- The [archived DNS prerequisite decision](../decisions/archived/testing/2026-11-15-qualify-temporary-tunnel-dns-within-bootstrap.md) records that implementation and its local controls. The prerequisite and those controls are retired; their recorded results remain historical evidence. The [original HTTPS readiness decision](../decisions/implemented/testing/2026-11-16-qualify-cross-os-readiness-through-original-https.md) owns the current fixture and preserves the ordinary transport and bootstrap budgets.

Public-network acceptance remains separate. The original 348e zero-HTTP failure is retained; later query facts can distinguish stages but cannot retroactively identify that run's cause.

## Lessons

For concurrent native work, observe the positive event separately from full settlement, then prove owned cancellation and drainage before the next stage. Preserve unknown failures even when another branch succeeded. Missing query facts limit diagnosis; a controlled ordering fix is not evidence that an earlier network failure had the same cause.
