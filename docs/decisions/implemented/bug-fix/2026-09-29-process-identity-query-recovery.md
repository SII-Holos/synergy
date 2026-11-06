# Decision Record: Recover from an unknown process identity

Status: implemented

## Problem

A transient failure to inspect the current process could be cached for its entire lifetime. Subsequent Workspace finalization requests then failed even after the operating system query recovered.

## Decision

The [process identity utility](../../../../packages/util/src/process-identity.ts) shares in-flight queries and caches a successful current-process identity. An unknown result clears only its own cache entry, allowing the next caller to query again. The failing request still receives `undefined`; callers retain their existing refusal to finalize unverified ownership and their conservative treatment of unknown lock owners.

The [behavioral regression](../../../../packages/util/test/process-identity.test.ts) isolates the operating-system query seam in a subprocess. It verifies concurrent deduplication, failure through both Windows query methods, recovery on a subsequent request, and successful-result caching. The [process start identity rules](2026-08-27-fs-lock-pid-recycling-start-identity.md) and canonical identity encoding remain unchanged.

The adjacent lock regression retains and explicitly closes handles whose close failure it simulates. This keeps the real resource owned by the fixture while preserving the caller-visible error; the [testing Skill](../../../../.synergy/skill/testing-guide/SKILL.md) records that cleanup requirement.

## Alternatives considered

**Retry within the failing request.** Rejected because the primitive must report unavailable evidence without extending the caller's wait or creating a retry loop.

**Treat the PID as sufficient identity.** Rejected because a recycled PID cannot establish ownership.

## Consequences

A temporary query failure does not disable later work for the lifetime of the runtime. Repeated requests during a continuing operating-system failure can each perform a query; concurrent requests still share one query, and unknown identity never grants ownership.
