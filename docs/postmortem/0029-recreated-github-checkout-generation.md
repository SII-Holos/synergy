# Recreated GitHub Checkout Generation

## Executive summary

Expiry deleted and recloned a GitHub checkout but could leave its Workspace generation unchanged when Linux reused the directory's physical identifier. Checkout preparation now treats its own clone operation as evidence of replacement.

## Summary

Repeated native Linux checkout tests found a generation of one where recreation required two. Two Sessions retained separate Workspace identities, but the expired directory's old reference remained valid. A deterministic regression reproduced the failure using real temporary Git repositories and a scoped directory-identification source that returns the prior identifier.

## Root cause

The provider compared the old and new physical identifiers to decide whether rebinding was necessary. That comparison ignored stronger lifecycle evidence: the provider had deleted the old directory and cloned replacement contents. Directory identity is not a permanent allocation counter.

## Guardrails added

- [Recreation advances the binding](../decisions/implemented/bug-fix/2026-09-23-recreated-github-workspace-generations.md) regardless of identifier reuse.
- [Native provider tests](../../packages/connections/test/channel/provider/github/workspace-ownership.test.ts) cover stable IDs, unchanged generations on refresh, generation changes on recreation, stale-reference refusal and separate Session ownership.
- [Channel development guidance](../../.synergy/skill/change-channel-runtime/SKILL.md) requires deterministic identifier-reuse coverage while retaining real Git operations.

## Lessons

Use lifecycle evidence when the application owns replacement. A physical-identity comparison cannot cancel an observed delete-and-create transition.
