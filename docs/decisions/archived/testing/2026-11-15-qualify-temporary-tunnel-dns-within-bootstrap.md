# Decision Record: Qualify temporary tunnel DNS within bootstrap

Status: implemented
Archived: 2026-11-16

## Problem

A newly issued temporary tunnel hostname can be selected and its local origin listening before the public endpoint is reachable. Starting ordinary HTTP immediately leaves public DNS readiness implicit. A later independent DNS answer cannot explain an earlier system-resolver failure or establish that the original endpoint was ready.

## Decision

The CrossOS fixture waits for a positive DNS answer for the exact captured QuickTunnel hostname before its first ordinary public HTTP request. The default factory constructs an independent `node:dns/promises` Resolver using its default servers, with the existing bounded native query options of 250 milliseconds and one try. It changes no global or operating-system DNS configuration.

Each round submits an A and an AAAA query concurrently. Either family may supply a nonempty valid answer and wake the readiness owner while its sibling is pending. The original `finally` cancels only this Resolver once and drains that same owned `allSettled` pair before HTTP can start; it does not submit another query. Both outcomes and the original bootstrap signal are checked after drainage. A known negative, no-data, timeout or owned-cancellation result from the sibling is allowed. An unexpected query failure retains its original reason, and an aborted bootstrap retains its original signal reason; an additional cancellation failure follows the original failure in the aggregate. A fully settled round without a positive answer yields for 250 milliseconds through the original signal before trying another pair.

DNS readiness and the subsequent HTTP work share the already-created 120-second bootstrap signal. Entering either stage does not create another bootstrap window. A window that ends without positive DNS fails before ordinary HTTP; no HTTP execution is not success. After DNS qualifies, the original five-second HTTP observer, captured hostname and URL, TLS verification, proxy behavior and automatic address-family selection remain. Resolved addresses are counted and discarded, never passed to HTTP. Original health-body validation, authenticated WSS and every native file, history, epoch, receipt and cleanup assertion must still pass.

[Cloudflare's Quick Tunnels documentation](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) describes temporary testing endpoints without an uptime guarantee. The local pinned `bun-types@1.4.3` `bun.d.ts` DNS backend documentation, corresponding to the [pinned Bun source](https://github.com/oven-sh/bun/blob/c6da4a4d3010e5553438c60f6bd76d981976867c/packages/bun-types/bun.d.ts), distinguishes the macOS system backend from c-ares. This fixture uses that distinction for a readiness precondition; it does not select a different backend for ordinary Bun HTTP or WSS.

## Alternatives considered

**Continue ordinary HTTP immediately after tunnel registration.** Registration and a listening local origin do not establish that the newly selected public name is ready. The independent prerequisite makes that distinction explicit without changing the later business path.

**Use DoH, chosen servers or resolved addresses for business requests.** Those choices would change the route being accepted. Only test-exclusive Resolver instances may point to a task-owned temporary DNS authority; the actual CrossOS default factory retains default servers.

**Extend bootstrap or relax TLS, proxy or family behavior.** Those changes would alter the tested contract without identifying the earlier failure. The original bootstrap and per-request budgets remain.

**Accept DNS success as endpoint or business readiness.** A record alone cannot establish a successful original HTTP response, authenticated connection or native handoff.

## Consequences

Setup performs additional real DNS work: one A/AAAA API pair per round, potentially repeated within the original bootstrap window. Native resolver packet counts can differ from API-call counts. The negative-round cadence, DNS wait and owned drainage consume time otherwise available to HTTP; they do not extend the allowance. Passive facts record per-family invocation, settlement and finite error-code counts, with at most first, last and first-positive samples for each family. Return observations count original record kinds and valid IP results during the same traversal. Failure observations retain finite classes, original-signal identity and query, parse, cancellation and drainage stages through descriptors, without invoking getters or retaining address, hostname or error-text values. Observation adds no query or timer and cannot establish readiness on its own.

An independent positive does not guarantee simultaneous success in the macOS system resolver. Early c-ares negative queries may also reach a shared upstream recursive cache. A failed prerequisite prevents the ordinary HTTP stage but does not identify the system-resolver, returned-record or public-route cause. The [incident record](../../../postmortem/0218-dns-positive-waited-for-pending-sibling.md) separates the controlled pending-sibling defect from unresolved public-network evidence.

## Validation

The original controls in `packages/organization-runtime/test/cross-os-control.test.ts` use real temporary UDP DNS and fixed loopback HTTP owners. They verify negative-to-positive readiness for either family, a positive answer while its native sibling remains held, no HTTP before cancellation and complete drainage, exhausted-window refusal, exact query and cancellation errors, original abort identity and a subsequent real HTTP failure. Passive-observation controls retain the same results, keep accessor reads at zero and exclude secret values. These checks prove owned ordering and error preservation; they do not reproduce public QuickTunnel routing or same-hostname macOS system caching. Executed results live in the incident record.
