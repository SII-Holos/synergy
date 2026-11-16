# Decision Record: Qualify CrossOS readiness through original HTTPS

Status: implemented

## Problem

An independent raw DNS query is not the resolver path of the original HTTPS request. Requiring its positive result can spend the entire bootstrap window before the transport being accepted runs. The two original CrossOS attempts at the same revision reached that prerequisite, received only independent `ENOTFOUND` results and started zero ordinary health requests; they do not establish whether the ordinary public route was available.

## Decision

The original public HTTPS health callback owns CrossOS readiness. It requests the captured tunnel URL through ordinary Bun fetch, requires an OK response and validates the original run identity and Darwin body before bootstrap proceeds. The complete callback, polling, TLS verification, proxy behavior, automatic address-family choice and original URL remain unchanged. Its five-second request signal shares the original 120-second bootstrap signal; there is no additional readiness window. Authenticated WSS, native handoff, files, history, epochs, signatures and cleanup remain independent required checks.

The independent DNS prerequisite and its query-ordering controls are removed. The superseded [DNS prerequisite decision](../../archived/testing/2026-11-15-qualify-temporary-tunnel-dns-within-bootstrap.md) is archived without rewriting its decision. The failure-only `observeDNSAfterFailedHealth` implementation remains unchanged: only an original health failure with recorded `ENOTFOUND` permits its bounded independent comparison. Its answers cannot establish readiness or replace the original error.

The pinned [Bun DNS backend documentation](https://github.com/oven-sh/bun/blob/c6da4a4d3010e5553438c60f6bd76d981976867c/packages/bun-types/bun.d.ts#L2534-L2595) distinguishes the macOS system resolver from c-ares. The pinned [Node DNS implementation](https://github.com/oven-sh/bun/blob/c6da4a4d3010e5553438c60f6bd76d981976867c/src/js/node/dns.ts) and [Resolver binding](https://github.com/oven-sh/bun/blob/c6da4a4d3010e5553438c60f6bd76d981976867c/src/runtime/dns_jsc/dns.rs) supply the independent channel. These are different observations, not interchangeable readiness authorities. [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) are temporary testing endpoints without an uptime guarantee.

## Alternatives considered

**Retain independent positive DNS as a prerequisite.** It cannot validate the ordinary HTTPS route and can prevent that route from being observed at all. A local control can deny the same hostname through a task-owned raw DNS authority while its trusted ordinary HTTPS route succeeds.

**Change DNS servers, inject resolved addresses or alter TLS, proxy, family or deadlines.** These changes would accept a different route or allowance. The public fixture keeps its original transport settings and budgets.

**Accept tunnel registration or a DNS answer as readiness.** Neither validates the actual HTTP status, response body or run identity. The original health response remains necessary, and it does not replace later WSS or business acceptance.

## Consequences

Bootstrap no longer performs independent prerequisite query rounds. The original HTTP work and any original retry remain within the same total allowance. This removes an invalid prerequisite; it does not identify the cause of earlier public resolver failures, guarantee QuickTunnel availability or establish a measured performance improvement.

The real local control uses one task-owned UDP DNS authority and trusted loopback HTTPS for the same hostname. It checks raw `ENOTFOUND`, successful original HTTPS identity validation, rejection of another run and preservation of the original abort reason without changing default DNS settings. It demonstrates the distinction between the owners, not public DNS or QuickTunnel behavior. Local control execution and new exact-head Darwin/Linux business acceptance are recorded separately in the [incident record](../../../postmortem/0223-independent-dns-prerequisite-blocked-original-https-readiness.md).
