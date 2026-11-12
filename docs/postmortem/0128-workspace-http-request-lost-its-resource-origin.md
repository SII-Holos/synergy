# Workspace HTTP request lost its resource origin

## Executive summary

A valid Workspace-file request returned HTTP 500 because middleware omitted the native origin required by resource admission. Registering the HTTP owner during composition and inheriting an existing frame's original origin restores file access without weakening provenance checks.

## Summary

The original Server Workspace-file test reached the actual request after native module-loading dependencies were corrected. Reading valid local files expected HTTP 200 and received 500. A second real SQLite and object-file fixture reproduced the same failure through the storage-backed blob owner.

## Timeline

1. The unchanged valid local HTTP case failed before file enumeration with status 500.
2. Explicitly composing the existing HTTP component still reproduced the failure, isolating missing request provenance from fixture composition.
3. A real object-backed Workspace request reproduced the failure with a dormant Environment selected.
4. HTTP composition registered its native Host capability, and middleware forwarded original frame provenance before asynchronous resolution.
5. Real local and object-file requests passed. The malformed-frame case rejected before any byte read, and dormant browsing made zero provider allocation calls.

## Root cause

Mandatory native origin admission was implemented at the resource owner, while Workspace-file middleware remained an unconverted caller. Its fixtures registered Local Runtime without the HTTP resource owner, which also needed explicit composition rather than late registration.

## Guardrails

- [x] Machine check: `packages/server/test/server/workspace-context.test.ts` observes actual blob-reader origins, inherited identity, missing-frame rejection and zero compute allocations.
- [x] Machine check: Workspace-file, Environment, selection and startup suites cover real HTTP reads and mutations, generation/Scope fences and the write startup barrier.
- [x] Procedure: the [Server API workflow](../../.synergy/skill/change-server-api/SKILL.md) requires composition-time origin selection and genuine file-owner verification.

## Lessons

Preserve the original resource invocation when converting a caller to mandatory native provenance. A Host capability supplies a genuinely new human request; it cannot repair an existing frame with missing authority. The [decision](../decisions/implemented/bug-fix/2026-11-12-preserve-workspace-http-request-origins.md) records the composition and request rules.
