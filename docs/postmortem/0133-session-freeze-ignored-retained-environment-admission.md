# Session freeze ignored retained Environment admission

## Executive summary

Final epoch publication accepted a paused Session while its native Environment admission Use remained retained. Checking canonical Uses independently of Execution records closes the gap without consuming unrelated invocations.

## Summary

A real canonical Session/root/Run/tool acquired an Environment through its opaque native origin. The provider request settled and no Execution record existed, but its original admission lease remained open. After pausing the Session, the real epoch owner published a final frozen record instead of refusing the retained occupancy.

## Timeline

1. A real SQLite fixture acquired the native admission and retained its original release function.
2. The paused Session's epoch freeze resolved despite the retained Use and missing Execution receipt.
3. Canonical Use inspection made freezing refuse until that original release completed.
4. A matching admission after 65 Host Uses still blocked; the independent Host and Session Uses remained live after successful freezing.
5. Unknown historical and cross-Scope Uses remained unchanged and blocked publication.
6. A real second Session preparation held after its admission publication exposed an incorrect requirement for its future Execution receipt. Its original preparation provenance distinguishes that independent owner without stopping it; its own cancellation still releases the Use and preserves the original error.

## Root cause

Execution discovery covered persisted operations and finite pending requests, but neither represents a caller retaining an already admitted resource lease. Resource preparation and durable execution publication have different lifetimes.

## Guardrails

- [x] Machine check: `packages/harness/test/session/transfer-environments.test.ts` verifies final publication refusal, full pagination, independent ownership, retained unknown facts and another Session's accepted preparation.
- [x] Machine check: native Execution-origin, Use-ownership and aggregate-admission suites retain pending-request guards, migration coverage, lost acknowledgements and final mutation fences.
- [x] Procedure: the [persistence workflow](../../.synergy/skill/change-persistence/SKILL.md) requires canonical Use inspection before Session freezing and forbids removing unknown occupancy as reconciliation.

## Lessons

An empty operation list does not establish released resource occupancy. Follow the original canonical owner and retain its unresolved facts. The [decision](../decisions/implemented/bug-fix/2026-11-12-drain-retained-environment-uses-before-session-freeze.md) records the qualification and publication rules.
