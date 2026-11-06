# Discovery omitted the selected Workspace

## Executive summary

Deferred capabilities disappeared in object-backed Sessions because discovery omitted the Workspace ID supplied by execution. Tests that only executed tools did not cover discovery from a context without a local directory. Both paths must use the same Session resource selection.

## Summary

A host with transitive tool dependencies could lose a service capability when its file-tool companion disappeared from the discovered catalog. Independent service tools remained available, obscuring the shared cause.

## Timeline

- 2026-10-06: real-model acceptance exposed a missing persistence tool after a successful Workspace write.
- A registry/discovery test reproduced the omission without a model, Docker or business service.
- Passing the recorded Workspace ID restored discovery while preserving explicit disabling.

## Root cause

`ToolRegistry.tools` accepts a logical Workspace ID, but `ToolDiscovery.collect` passed only the provider and agent. The registry therefore treated Workspace-dependent tools as unavailable when the discovery context had no native directory.

## Guardrails added

- [Implementation decision](../decisions/implemented/bug-fix/2026-10-06-discover-tools-for-selected-workspace.md).
- Discovery tests cover an object Workspace, no Workspace, explicit tool disabling and no compute allocation.

## Lessons

Availability tests must include discovery from a dormant logical Workspace; successful file execution alone cannot verify the model's capability catalog.
