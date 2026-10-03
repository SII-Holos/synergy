# Directory Replacement Blocked History

## Executive summary

A successful data upgrade could leave project conversations unreadable when their default directory had been replaced. Request setup tried to register that directory before reading saved metadata. File-access checks correctly rejected the replacement, but the same rejection unintentionally blocked history. Default context must describe existing bindings without renewing native authority.

## Summary

Service startup and migration checks passed. Historical Session requests returned `WorkspaceUnavailable`, even though their messages were retained in storage. Scope bootstrap and path reads failed at the same request boundary.

## Timeline

On 2026-10-03, isolated upgrade acceptance detected the history failures after successful startup. A temporary-directory regression reproduced the failure before the fix. Repeating the historical reads after the fix succeeded without rebinding or rewriting saved Workspace identities.

## Root cause

Implicit Scope context shared the adoption path used for initial Workspace registration. Re-entering a project Scope therefore compared its current physical directory with the saved binding. Existing route tests verified rejection of replacement file access but did not check metadata reads through the full request middleware after the default directory changed.

## Guardrails added

- [Catalog description](../decisions/implemented/bug-fix/2026-09-23-unverified-workspace-directory-bindings.md) preserves saved identity during implicit Scope setup.
- [Mounted HTTP regression](../../packages/server/test/server/workspace-selection.test.ts) checks historical text, bootstrap, path metadata, snapshot headers, foreign Scope refusal and replacement-file rejection.
- [Testing guidance](../../.synergy/skill/testing-guide/SKILL.md) requires historical-read checks alongside unavailable-directory admission checks.

## Lessons

Healthy startup does not establish that retained conversations can be opened. Test metadata availability independently from native file authority, through the same middleware used by the application.
