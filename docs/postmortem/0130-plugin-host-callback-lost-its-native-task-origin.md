# Plugin Host callback lost its native Task origin

## Executive summary

Plugin Workspace callbacks omitted mandatory native origins. A generic Host repair restored file access but incorrectly attributed an Agent Tool with deferred Workspace requirements to the Host. Private native provenance across IPC preserves the original Task's authority.

## Summary

A real plugin process failed to read dormant object files because resource admission received no origin. After a registered Plugin Host restored independent invocations, a real `requiresWorkspace: false` Tool read succeeded with the wrong Host origin. A further real process invocation accepted one Session's valid origin while selecting another Session in the same Scope.

## Timeline

1. The existing dormant process scenario rejected with missing native provenance.
2. Composition registered a Plugin Host, and independent process file reads passed without compute.
3. A real Tool source, native Run/tool ledger, process callback and canonical blob reader reproduced Host attribution for an Agent Tool.
4. The Tool adapter captured its canonical assistant/root/Run/full-tool/call identity in private async context; the same blob read retained the exact Session origin.
5. A same-Scope, different-Session invocation resolved with an inherited source origin. An exact invocation binding check made it reject before byte reads.
6. Forged or absent calls and paused Task admission rejected, while an independent UI operation remained available through its own Host origin.

## Root cause

Invocation context retained file selection and task access but omitted the native resource origin. Eager Workspace resolution usually supplied that provenance, hiding the gap for tools that requested files only during a later Host call. Actor and call display labels could not replace canonical native evidence.

## Guardrails

- [x] Machine check: `packages/plugin-host/test/plugin-runtime/workspace-origin.test.ts` verifies exact canonical Tool provenance through the actual process IPC and blob reader, missing provenance, foreign Session selection, forged calls and paused admission.
- [x] Machine check: Workspace context/Environment, Tool invocation and shell Host Service suites retain native save, cancellation and pending callback drainage behavior.
- [x] Procedure: the [Plugin Runtime workflow](../../.synergy/skill/change-plugin-runtime/SKILL.md) requires host-private provenance and deferred-resource Tool coverage.

## Lessons

An invocation's original native identity must survive every callback, including when no resources were eagerly resolved. A registered Host authorizes a separate invocation; it cannot replace a Task's provenance. The [decision](../decisions/implemented/bug-fix/2026-11-12-retain-native-plugin-resource-origins.md) records this separation.
