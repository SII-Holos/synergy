# Decision Record: Qualify temporary tunnel DNS within bootstrap

Status: implemented

## Problem

A newly issued temporary tunnel hostname can be selected and its local origin listening before the public endpoint is reachable. Starting ordinary HTTP immediately leaves public DNS readiness implicit. A later independent DNS answer cannot explain an earlier system-resolver failure or establish that the original endpoint was ready.

## Decision

The CrossOS fixture waits for a positive DNS answer for the exact captured QuickTunnel hostname before its first ordinary public HTTP request. The default factory constructs an independent `node:dns/promises` Resolver using its default servers, with the existing bounded native query options of 250 milliseconds and one try. It changes no global or operating-system DNS configuration.

Each round submits an A and an AAAA query concurrently. Either family may supply a nonempty valid answer; a known negative, no-data or timeout result from the other family is allowed. The fixture waits for the same owned `allSettled` pair before examining both outcomes. Unexpected errors retain their original reasons, and cancellation preserves the original abort reason. Cleanup cancels only this Resolver and drains that same pair. Failed rounds yield for 250 milliseconds through the original signal before trying another pair.

DNS readiness and the subsequent HTTP work share the already-created 120-second bootstrap signal. Entering either stage does not create another bootstrap window. A window that ends without positive DNS fails before ordinary HTTP; no HTTP execution is not success. After DNS qualifies, the original five-second HTTP observer, captured hostname and URL, TLS verification, proxy behavior and automatic address-family selection remain. Resolved addresses are counted and discarded, never passed to HTTP. Original health-body validation, authenticated WSS and every native file, history, epoch, receipt and cleanup assertion must still pass.

[Cloudflare's Quick Tunnels documentation](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) describes temporary testing endpoints without an uptime guarantee. The local pinned `bun-types@1.4.3` `bun.d.ts` DNS backend documentation, corresponding to the [pinned Bun source](https://github.com/oven-sh/bun/blob/c6da4a4d3010e5553438c60f6bd76d981976867c/packages/bun-types/bun.d.ts), distinguishes the macOS system backend from c-ares. This fixture uses that distinction for a readiness precondition; it does not select a different backend for ordinary Bun HTTP or WSS.

## Alternatives considered

**Continue ordinary HTTP immediately after tunnel registration.** Registration and a listening local origin do not establish that the newly selected public name is ready. The independent prerequisite makes that distinction explicit without changing the later business path.

**Use DoH, chosen servers or resolved addresses for business requests.** Those choices would change the route being accepted. Only test-exclusive Resolver instances may point to a task-owned temporary DNS authority; the actual CrossOS default factory retains default servers.

**Extend bootstrap or relax TLS, proxy or family behavior.** Those changes would alter the tested contract without identifying the earlier failure. The original bootstrap and per-request budgets remain.

**Accept DNS success as endpoint or business readiness.** A record alone cannot establish a successful original HTTP response, authenticated connection or native handoff.

## Consequences

Setup performs additional real DNS work: one A/AAAA API pair per round, potentially repeated within the original bootstrap window. Native resolver packet counts can differ from API-call counts. The negative-round cadence and DNS wait consume time otherwise available to HTTP; this is a new fixture cost, not a free diagnostic or a longer allowance. Safe metadata retains only attempts, answer counts and elapsed time, without addresses or the hostname.

An independent positive does not guarantee simultaneous success in the macOS system resolver. Early c-ares negative queries may also reach a shared upstream recursive cache. The original approximately 83-second error transition, system negative caching and the cause of prior public-health failures remain unproved. Real CrossOS acceptance with this prerequisite has not yet run, so the change is a readiness improvement awaiting CI validation.

## Validation

Real temporary UDP DNS and fixed loopback HTTP owners verify that HTTP waits for actual negative DNS followed by either an A or AAAA positive, that an exhausted window starts no HTTP, and that cancellation settles both original native queries before closing the owned UDP authority. A subsequent real HTTP failure retains its original error. The complete local control file passes 15 cases and 168 assertions, and the owning TypeScript check passes. These controls prove ordering, cancellation and error identity; they do not reproduce public QuickTunnel routing or same-hostname macOS system caching.
