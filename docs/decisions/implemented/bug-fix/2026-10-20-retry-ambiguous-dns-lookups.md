# Decision Record: Retry ambiguous DNS lookup failures through existing recovery

Status: implemented

## Problem

The shared network classifier treated `ENOTFOUND` as a permanent address failure. A model request to a valid provider could therefore stop after one lookup failure even when name resolution subsequently recovered. The prior policy equated an ambiguous operating-system error with proof that the hostname was invalid.

[Node's lookup contract](https://nodejs.org/docs/latest-v22.x/api/dns.html#dnslookuphostname-options-callback) explicitly states that `ENOTFOUND` can also represent other lookup failures, including unavailable file descriptors. The error alone cannot distinguish those conditions from a nonexistent host. This supersedes only the `ENOTFOUND` admission choice in [network retry boundaries](2026-09-15-network-retry-boundaries.md); its ownership and replay constraints remain in force.

## Decision

`packages/util/src/network-error.ts` classifies `ENOTFOUND` as transient, meaning recovery may help rather than that recovery is guaranteed. Structured codes, nested and aggregate causes, and message-only errors follow the same provider-independent classifier. Error metadata continues to retain the original code, syscall and endpoint host.

Each existing caller retains its own retry ownership. Ordinary sessions keep the existing ten additional model attempts with SDK retries disabled; SDK-admitting callers, derived calls and read helpers retain their existing limits and cancellation. No DNS-specific loop, hostname exception, new delay, additional budget or transport replay is introduced. A failure after tool dispatch still cannot repeat the model or tool effect.

Definitive address codes such as `ENONAME`, `EAI_NONAME`, `ENODATA` and `EBADNAME` remain terminal. Cancellation and mapped certificate failures keep their existing precedence over a retryable sibling. Authentication, billing, invalid requests, recording failures and exhausted SDK retry errors remain unchanged. Existing persisted terminal errors are not migrated or silently resumed.

## Alternatives considered

**Keep every `ENOTFOUND` failure terminal.** Rejected because the code is not sufficient evidence of a permanent configuration error and prevents recovery from a temporary lookup failure.

**Retry only a known provider hostname or probe DNS independently.** Rejected because the same system failure affects arbitrary providers, a separate lookup can use a different resolver path or race the actual request, and hostname rules would create another classification policy.

**Add a separate DNS retry loop or change the retry budgets.** Rejected because the existing owners already define attempts, backoff, cancellation and replay safety. Another loop would multiply attempts or narrow recovery inconsistently.

## Consequences

A temporarily failing lookup can recover through the existing network policy. A genuinely invalid hostname that reports only `ENOTFOUND` now takes longer to fail because it consumes the caller's normal retry budget; retry does not repair configuration or guarantee network availability. Deterministic fault injection proves recovery and terminal exhaustion, not the DNS or proxy cause of a historical outage.

The focused tests cover raw and message-only classification, nested worker error transport, real SDK startup, recovery with one tool effect, persisted retry indices and terminal exhaustion, and no replay after dispatch. Existing title-ownership coverage uses a definitive address error so it continues to test a terminal first attempt rather than depending on the superseded DNS policy.
