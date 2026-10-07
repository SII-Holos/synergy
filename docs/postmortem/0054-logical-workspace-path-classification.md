# Logical Workspace paths were classified as external

## Executive summary

A file tool requested external-directory permission for a path inside its selected object Workspace. File execution supported the logical namespace while authorization knew only the physical directory. Direct classifier coverage missed a second omission in the isolated policy worker. The fix carries the same selected namespace through both paths and verifies actual tool resolution.

## Summary

A valid absolute logical write was rejected before execution. Relative file paths remained functional, which concealed the mismatch in narrower tests.

## Timeline

- 2026-10-06: a real-model acceptance case exposed the false external-write classification.
- A failing resolved-tool test reproduced it without the model or business adapter.
- Classifier tests passed after carrying the logical root, but the resolved-tool test still failed until the policy-worker context also carried it.
- Focused tests verified permitted file paths and unchanged native and shell restrictions.

## Root cause

Resource resolution, in-process classification and isolated classification did not share all path context. The file executor interpreted the logical root while both classifiers initially omitted it.

## Guardrails added

- [Implementation decision](../decisions/implemented/bug-fix/2026-10-06-authorize-logical-workspace-files.md).
- Resolved file-tool tests exercise logical absolute reads and writes.
- Classification tests cover the isolated worker, traversal, sibling prefixes, native roots and unchanged shell classification.

## Lessons

A permission-context change requires an executed-tool regression across the worker protocol; a passing local classifier cannot establish that the execution path receives the same inputs.
