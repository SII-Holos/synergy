# Unverified Workspace Directory Access

## Executive summary

A directory absent during legacy Workspace migration could later be recreated with unrelated files and accessed using the historical Workspace reference. The binding retained a path but no physical identity, and validation skipped comparison when that identity was absent. Native admission now requires a verified identity or explicit rebinding.

## Summary

Final review identified that repeated registration intentionally preserves an existing binding without filling missing physical metadata. A real temporary-filesystem regression then migrated an absent directory, created a new directory at the same path and requested a file through the Workspace HTTP API. The request returned success instead of `WorkspaceUnavailable`. The active acceptance window was stopped before changing the product build.

## Root cause

Migration must retain missing locations so historical Sessions and files can be understood. That legitimate incomplete metadata was treated as an optional comparison during native validation. A path becoming available supplied no evidence that its contents belonged to the historical Workspace, but the old binding generation still admitted them.

## Guardrails added

- [Verified identity admission](../decisions/implemented/bug-fix/2026-09-23-unverified-workspace-directory-bindings.md) preserves historical metadata while refusing unverified local access.
- [Workspace route regression](../../packages/server/test/server/workspace-selection.test.ts) creates the missing path, repeats registration, checks refusal, explicitly rebinds, checks successful access, and rejects both stale generations and a replacement directory.
- [Testing guidance](../../.synergy/skill/testing-guide/SKILL.md) includes absent-at-migration and later-reappearance cases.

## Lessons

Optional historical metadata must not silently weaken execution preconditions. A missing original identity and a verified identity that later disappears are distinct cases; both require explicit evidence before a different directory can become authoritative.
