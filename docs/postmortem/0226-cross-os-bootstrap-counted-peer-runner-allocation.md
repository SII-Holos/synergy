# Cross-OS bootstrap counted peer runner allocation

## Executive summary

The Linux CrossOS peer exhausted its business bootstrap before the Darwin runner started. Publishing identity before native setup did not establish that the other peer could execute. The fixed two-role workflow needs a separate bounded assembly phase before the original bootstrap clock begins.

## Summary

The failed attempt made no Handoff business request and did not test the object-proof repair. It is a CI preparation failure, not evidence of a product, DNS or authorization defect. Both real peers and the complete original native roundtrip remain required.

## Timeline

- The Linux native peer started at 15:20:24 UTC and exhausted the original bootstrap at 15:22:24.
- Linux cleanup completed at 15:22:26. The Darwin runner actually started at 15:29:48, 442 seconds later, and began its native peer at 15:30:43. The peer lifetimes never overlapped.
- The workflow moves its existing public artifact publication after native dependencies and waits for the opposite prepared role within a separate 15-minute allowance. The original native launch and 120-second clock follow that gate.

## Root cause

The fixture treated another runner’s allocation and setup as business bootstrap work. An early identity artifact could exist while its producer was still preparing native dependencies. Without a prepared-peer gate, increasing or retrying the business window could repeat the same unmet prerequisite.

## Guardrails

- [x] Machine check: `test/script/ci-topology.test.ts` — actual configured native downloads and installation precede public publication; paired assembly precedes the original native launch within a finite job envelope.
- [x] Machine check: `packages/organization-runtime/test/cross-os-control.test.ts` — an already-aborted assembly rejects the original reason before reading identity or requesting artifacts, for either role.
- [ ] Machine check: exact-head real CrossOS workflow — both prepared peer artifacts precede native launch; original HTTPS, authenticated WSS, full bidirectional native work and cleanup pass.
- The [original-producer decision](../decisions/implemented/testing/2026-11-14-bind-cross-os-native-acceptance-to-original-producers.md) owns assembly and provenance. The business bootstrap, per-request and object authorization windows remain unchanged.

## Lessons

Establish the concrete prerequisites of a distributed test before starting its business clock. A ready artifact proves completed setup only; it never substitutes for the actual transport, native work or cleanup result.
